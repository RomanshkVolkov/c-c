package http

import (
	"context"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/adapters/handler"
	"github.com/guz-studio/cac/backend/internal/adapters/imageservice"
	"github.com/guz-studio/cac/backend/internal/adapters/mediastore"
	"github.com/guz-studio/cac/backend/internal/adapters/middleware"
	"github.com/guz-studio/cac/backend/internal/core/events"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

// InitTaskRoutes mounts the task module. Everything is JWT-authenticated and
// org-scoped through the space that owns each node.
func InitTaskRoutes(db *gorm.DB, r *chi.Mux, hub *events.Hub) {
	taskRepo := repository.NewTaskRepository(db)
	// El buzón se construye antes que nada porque ahora lo comparten cuatro
	// servicios, no dos. Ver el comentario de más abajo, que ya explicaba por
	// qué es uno solo.
	inbox := service.NewNotificationService(repository.NewNotificationRepository(db))
	svc := service.NewTaskService(taskRepo, repository.NewReportRepository(db), repository.NewOrganizationRepository(db), hub).
		WithNotifier(inbox)
	// The same channel service the reports screen uses. One row, one set of
	// rules, reachable from wherever the person happens to be.
	channels := service.NewReportProjectService(
		repository.NewReportProjectRepository(db),
		repository.NewOrganizationRepository(db),
	)
	// Same image-service client as reports: attachments are proxied so its API
	// key and the bucket never reach the desktop app.
	images := imageservice.New(
		repository.GetEnv("IMAGE_SERVICE_URL", ""),
		repository.GetEnv("IMAGE_SERVICE_CERT_CN", ""),
		repository.GetEnv("IMAGE_SERVICE_API_KEY", ""),
	)
	// Same private bucket as report screenshots: attachments are streamed back
	// through us because the bucket denies anonymous reads.
	store, err := mediastore.New(
		context.Background(),
		repository.GetEnv("REPORTS_MEDIA_BUCKET", ""),
		repository.GetEnv("REPORTS_MEDIA_REGION", ""),
		repository.GetEnv("REPORTS_MEDIA_ACCESS_KEY_ID", ""),
		repository.GetEnv("REPORTS_MEDIA_SECRET_ACCESS_KEY", ""),
	)
	if err != nil {
		lg.Error("task attachment store init failed: " + err.Error())
	}
	// One notifier for all of them: being mentioned, being written to and being
	// answered are things that happen *to* a person, and they are the ones that
	// have to survive closing the app.
	chat := service.NewChatService(repository.NewChatRepository(db), hub).WithNotifier(inbox)
	dms := service.NewDMService(repository.NewDMRepository(db), hub).WithNotifier(inbox)
	// La voz sale de las mismas envs que consume LiveKit; sin ellas el handler
	// contesta 501 en vez de fingir que hay un SFU.
	voice := service.NewVoiceService(
		repository.GetEnv("LIVEKIT_URL", ""),
		repository.GetEnv("LIVEKIT_API_KEY", ""),
		repository.GetEnv("LIVEKIT_API_SECRET", ""),
	)
	h := handler.NewTaskHandler(svc, channels, chat, dms, taskRepo, images, store, voice)

	// The navigator: spaces → folders → lists.
	r.Route("/api/v1/task-spaces", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.Tree)
		r.Post("/", h.CreateSpace)
		// Antes que "/{id}": chi casa las rutas literales primero, pero dejarlas
		// juntas evita que alguien mueva una y cree una sala llamada "general".
		r.Post("/general", h.EnsureGeneralSpace)
		r.Patch("/{id}", h.UpdateSpace)
		r.Delete("/{id}", h.DeleteSpace)
		r.Post("/{id}/folders", h.CreateFolder)
		r.Post("/{id}/lists", h.CreateList)
		r.Post("/{id}/move", h.MoveSpace)
		r.Post("/{id}/sort", h.SortSpace)
		// The channel into this space: the credential work arrives with, and the
		// rules it arrives under.
		r.Get("/{id}/channel", h.GetChannel)
		r.Post("/{id}/channel", h.CreateChannel)
		r.Patch("/{id}/channel", h.UpdateChannel)
		r.Post("/{id}/channel/rotate-key", h.RotateChannelKey)
		// The space's channel of conversation. Internal by construction — see
		// domain/chat.go for why the table has no visibility column.
		r.Get("/{id}/chat", h.ListChat)
		r.Post("/{id}/chat", h.PostChat)
		r.Patch("/{id}/chat/{messageId}", h.EditChat)
		r.Delete("/{id}/chat/{messageId}", h.WithdrawChat)
		r.Post("/{id}/chat/read", h.MarkChatRead)
		r.Post("/{id}/chat/follow", h.FollowChannel)
		r.Delete("/{id}/chat/follow", h.UnfollowChannel)
		r.Post("/{id}/chat/attachments", h.UploadChatAttachment)
		// La entrada a la sala de voz de este espacio. Mismo guard que el chat.
		r.Post("/{id}/voice/token", h.VoiceToken)
		r.Post("/{id}/voice/ring", h.VoiceRing)
		r.Delete("/{id}/voice/ring/{userId}", h.VoiceRingCancel)
	})

	r.Route("/api/v1/task-folders", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateFolder)
		r.Delete("/{id}", h.DeleteFolder)
		r.Post("/{id}/move", h.MoveFolder)
		r.Post("/{id}/duplicate", h.DuplicateFolder)
		r.Post("/{id}/sort", h.SortFolder)
		r.Post("/{id}/move-to-space", h.MoveFolderToSpace)
	})

	r.Route("/api/v1/task-lists", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateList)
		r.Delete("/{id}", h.DeleteList)
		r.Post("/{id}/move", h.MoveList)
		r.Post("/{id}/move-to-space", h.MoveListToSpace)
		r.Get("/{id}/board", h.Board)
		r.Get("/{id}/statuses", h.Statuses)
		r.Post("/{id}/statuses", h.CreateStatus)
		r.Post("/{id}/tasks", h.CreateTask)
		// A list can carry its own binding, so it can configure it too.
		r.Get("/{id}/channel", h.GetListChannel)
		r.Patch("/{id}/channel", h.UpdateListChannel)
		r.Post("/{id}/channel/rotate-key", h.RotateListChannelKey)
	})

	// Every channel with unread lines, in one call — the navigator asks on every
	// load, and one request per space would be one request per space.
	r.With(middleware.AuthMiddleware).Get("/api/v1/chat/unread", h.ChatUnread)

	// Quién está en cada canal de voz. Una llamada para todos los espacios: la
	// lista de canales los pinta a la vez y una petición por canal sería una
	// petición por canal.
	r.With(middleware.AuthMiddleware).Get("/api/v1/chat/voice-presence", h.VoicePresence)
	r.With(middleware.AuthMiddleware).Get("/api/v1/chat/following", h.FollowedChannels)

	// Direct messages. Their own space in the API for the same reason they have
	// their own tables: nothing about a private conversation should be reachable
	// by asking about a space.
	r.Route("/api/v1/dm", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListDMConversations)
		// Opening is a POST because it may create the thread — but it is
		// idempotent: naming the same person again returns the same row.
		r.Post("/open", h.OpenDM)
		r.Get("/{id}/messages", h.ListDMMessages)
		r.Post("/{id}/messages", h.PostDM)
		r.Patch("/{id}/messages/{messageId}", h.EditDM)
		r.Delete("/{id}/messages/{messageId}", h.WithdrawDM)
		r.Post("/{id}/read", h.MarkDMRead)
	})

	r.Route("/api/v1/task-statuses", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Patch("/{id}", h.UpdateStatus)
		r.Post("/{id}/move", h.MoveStatus)
		r.Delete("/{id}", h.DeleteStatus) // ?moveTo=<statusId> absorbs its tasks
	})

	r.Route("/api/v1/tasks", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		// Across every list, unlike the board. The dashboard's pending list.
		r.Get("/", h.ListOpen)
		r.Get("/{id}", h.GetTask)
		r.Patch("/{id}", h.UpdateTask)
		r.Delete("/{id}", h.DeleteTask)
		r.Post("/{id}/move", h.MoveTask)
		r.Post("/{id}/watch", h.Watch)
		r.Delete("/{id}/watch", h.Unwatch)
		r.Post("/{id}/comments", h.AddComment)
		r.Patch("/{id}/comments/{commentId}", h.EditComment)
		r.Delete("/{id}/comments/{commentId}", h.DeleteComment)
		r.Post("/{id}/attachments", h.UploadAttachment)
		r.Delete("/{id}/attachments/{attachmentId}", h.DeleteAttachment)
	})

	// Outside the JWT group: a webview <img> can't send an Authorization header,
	// so this one authorizes from `?token=` as well. Same pattern as the report
	// image proxy.
	r.Get("/api/v1/tasks/{id}/attachments/{attachmentId}/raw", h.RawAttachment)
	r.Get("/api/v1/task-spaces/{id}/chat/attachments/{attachmentId}/raw", h.RawChatAttachment)

	// Docs: one markdown overview per space/folder/list, sharing the task
	// module's image-service client and media store.
	docH := handler.NewDocHandler(
		service.NewDocService(repository.NewDocRepository(db)), images, store,
	)
	r.Route("/api/v1/docs", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", docH.Index) // ?orgId= — which nodes have a document
		r.Get("/{kind}/{ownerId}", docH.Get)
		// El guardado entero se queda: una app de una versión anterior lo sigue
		// usando, y escribe en la pestaña que le corresponde.
		r.Put("/{kind}/{ownerId}", docH.Save)
		r.Put("/{kind}/{ownerId}/tabs/{tab}", docH.SaveTab)
		r.Patch("/{kind}/{ownerId}", docH.Patch)
		r.Get("/{kind}/{ownerId}/versions", docH.Versions)
		r.Post("/{kind}/{ownerId}/versions/{versionId}/restore", docH.Restore)
		r.Post("/{id}/attachments", docH.UploadAttachment)
		r.Delete("/{id}/attachments/{attachmentId}", docH.DeleteAttachment)
	})
	// Outside the JWT group: an <img> can't send the Authorization header.
	r.Get("/api/v1/docs/{id}/attachments/{attachmentId}/raw", docH.RawAttachment)

	r.Route("/api/v1/task-tags", func(r chi.Router) {
		r.Use(middleware.AuthMiddleware)
		r.Get("/", h.ListTags)
		r.Post("/", h.CreateTag)
	})

	// Notes: a separate, personally-owned module (see note.go's package doc).
	// Mounted here, not given its own InitRoutes call, so it reuses the
	// image-service client and media store already built above instead of
	// constructing a third copy of both from the same env vars.
	InitNoteRoutes(db, r, images, store)
}
