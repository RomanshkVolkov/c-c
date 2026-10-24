package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/events"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

// Backups de bases (#166). El servicio:
//   - programa: el reloj encola lo que toca (FireDue);
//   - reparte los trabajos al agente de cada servidor (Claim) y recibe su log
//     y su cierre;
//   - firma las URLs de subida y bajada (el backend nunca toca los bytes);
//   - borra de S3 lo vencido (Purge);
//   - avisa a los admins de la organización cuando algo falla o se calla.

var (
	ErrBackupsDisabled = errors.New("backups-not-configured")
	ErrNoRecipient     = errors.New("backups-need-a-recipient")
	ErrBadRecipient    = errors.New("invalid-age-public-key")
	ErrNothingToTest   = errors.New("no-backup-to-test")
	ErrNotABackupJob   = errors.New("not-a-backup-job")
	// ErrAgentTooOldForUsername: un usuario fijo con un agente que no lo
	// entiende rompería cada backup (ver domain.AgentVersionBackupUsername).
	ErrAgentTooOldForUsername = errors.New("backup-agent-too-old")
)

// BackupStore: lo que el servicio necesita de S3. Una interfaz para probarlo
// sin el bucket.
type BackupStore interface {
	Enabled() bool
	Prefix() string
	PresignPut(ctx context.Context, key string, size int64, sha256hex string, retainUntil time.Time) (*domain.PresignedRequest, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (*domain.PresignedRequest, error)
	DeleteAllVersions(ctx context.Context, key string) error
}

type backupServers interface {
	FindByID(id string) (*domain.Server, error)
}

type backupOrgs interface {
	AdminIDs(orgID string) ([]string, error)
}

type BackupService struct {
	repo    *repository.BackupRepository
	servers backupServers
	orgs    backupOrgs
	store   BackupStore
	hub     *events.Hub
	inbox   Notifier
	now     func() time.Time
	// Lo que vive una URL de bajada para una persona y para el agente.
	personTTL, agentTTL time.Duration
}

func NewBackupService(repo *repository.BackupRepository, servers backupServers, orgs backupOrgs, store BackupStore, hub *events.Hub, inbox Notifier) *BackupService {
	return &BackupService{
		repo: repo, servers: servers, orgs: orgs, store: store, hub: hub, inbox: inbox, now: time.Now,
		personTTL: 5 * time.Minute, agentTTL: 30 * time.Minute,
	}
}

func (s *BackupService) Enabled() bool { return s.store != nil && s.store.Enabled() }

func (s *BackupService) publish(orgID, kind string, data any) {
	if s.hub != nil {
		s.hub.Publish(events.Event{Type: kind, OrgID: orgID, Data: data})
	}
}

// ─── Bases (la app) ───────────────────────────────────────────────────────────

func (s *BackupService) ListTargets(serverID string) ([]domain.BackupTarget, error) {
	return s.repo.ListTargets(serverID)
}

// applyRequest copia el formulario a la base y la pone en hora.
func (s *BackupService) applyRequest(t *domain.BackupTarget, req domain.BackupTargetRequest) error {
	t.ServiceName, t.Engine, t.Database, t.CredentialEnv = req.ServiceName, req.Engine, req.Database, req.CredentialEnv
	t.Username = req.Username
	t.EveryHours, t.AnchorTime, t.Timezone = req.EveryHours, req.AnchorTime, req.Timezone
	t.KeepDays, t.KeepWeekly, t.KeepMonthly = req.KeepDays, req.KeepWeekly, req.KeepMonthly
	t.RestoreTestEveryDays = req.RestoreTestEveryDays
	if req.Enabled != nil {
		t.Enabled = *req.Enabled
	}
	if err := t.Validate(); err != nil {
		return err
	}
	now := s.now()
	next, err := domain.NextBackupRun(*t, now)
	if err != nil {
		return err
	}
	t.NextRunAt = &next
	t.NextRestoreTestAt = nil
	if t.RestoreTestEveryDays > 0 {
		// La primera prueba, un día después del primer backup que tocará: sin
		// backup no hay nada que probar.
		first := next.Add(24 * time.Hour)
		t.NextRestoreTestAt = &first
	}
	return nil
}

// CreateTarget: sin al menos una llave de la organización no se programa nada.
// Un backup que nadie puede abrir sólo ocupa sitio.
func (s *BackupService) CreateTarget(server *domain.ServerResponse, req domain.BackupTargetRequest) (*domain.BackupTarget, error) {
	if req.Username != "" && server.AgentVersion < domain.AgentVersionBackupUsername {
		return nil, ErrAgentTooOldForUsername
	}
	keys, err := s.repo.OrgRecipients(server.OrgID)
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return nil, ErrNoRecipient
	}
	t := &domain.BackupTarget{OrgID: server.OrgID, ServerID: server.ID, Enabled: true}
	if err := s.applyRequest(t, req); err != nil {
		return nil, err
	}
	if err := s.repo.CreateTarget(t); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *BackupService) UpdateTarget(server *domain.ServerResponse, id string, req domain.BackupTargetRequest) (*domain.BackupTarget, error) {
	if req.Username != "" && server.AgentVersion < domain.AgentVersionBackupUsername {
		return nil, ErrAgentTooOldForUsername
	}
	t, err := s.repo.FindTarget(server.ID, id)
	if err != nil {
		return nil, err
	}
	if err := s.applyRequest(t, req); err != nil {
		return nil, err
	}
	if err := s.repo.SaveTarget(t); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *BackupService) DeleteTarget(serverID, id string) error {
	return s.repo.DeleteTarget(serverID, id)
}

// RunNow: un backup a mano.
func (s *BackupService) RunNow(serverID, id, userID string) (*domain.Backup, error) {
	t, err := s.repo.FindTarget(serverID, id)
	if err != nil {
		return nil, err
	}
	return s.enqueue(t, domain.BackupKindManual, userID, "")
}

// TestNow: probar a restaurar el último bueno, a mano.
func (s *BackupService) TestNow(serverID, id, userID string) (*domain.Backup, error) {
	t, err := s.repo.FindTarget(serverID, id)
	if err != nil {
		return nil, err
	}
	src, err := s.repo.LastSucceeded(t.ID)
	if err != nil {
		return nil, ErrNothingToTest
	}
	return s.enqueue(t, domain.BackupKindRestoreTest, userID, src.ID)
}

func (s *BackupService) enqueue(t *domain.BackupTarget, kind, userID, sourceID string) (*domain.Backup, error) {
	b := &domain.Backup{
		OrgID: t.OrgID, ServerID: t.ServerID, TargetID: t.ID,
		Kind: kind, Status: domain.BackupQueued, RequestedBy: userID, SourceBackupID: sourceID,
	}
	if err := s.repo.CreateBackup(b); err != nil {
		return nil, err
	}
	s.publish(b.OrgID, "backup:status", b)
	return b, nil
}

func (s *BackupService) History(serverID, targetID string, limit int) ([]domain.Backup, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.repo.ListBackups(serverID, targetID, limit)
}

func (s *BackupService) Backup(serverID, id string) (*domain.Backup, error) {
	return s.repo.FindBackup(serverID, id)
}

// DownloadURL: el fichero **cifrado**, por cinco minutos, para un admin. Sólo
// de un backup bueno que sigue en el bucket.
func (s *BackupService) DownloadURL(ctx context.Context, serverID, id string) (*domain.PresignedRequest, error) {
	if !s.Enabled() {
		return nil, ErrBackupsDisabled
	}
	b, err := s.repo.FindBackup(serverID, id)
	if err != nil {
		return nil, err
	}
	if b.Status != domain.BackupSucceeded || b.ObjectKey == "" || b.PurgedAt != nil {
		return nil, ErrNothingToTest
	}
	return s.store.PresignGet(ctx, b.ObjectKey, s.personTTL)
}

// ─── Destinatarios ────────────────────────────────────────────────────────────

func (s *BackupService) Recipients(orgID string) ([]domain.BackupRecipient, error) {
	return s.repo.OrgRecipients(orgID)
}

func (s *BackupService) AddRecipient(orgID string, req domain.BackupRecipientRequest) (*domain.BackupRecipient, error) {
	if !domain.ValidAgePublicKey(req.PublicKey) {
		return nil, ErrBadRecipient
	}
	rc := &domain.BackupRecipient{OrgID: orgID, Label: req.Label, PublicKey: req.PublicKey}
	if err := s.repo.AddRecipient(rc); err != nil {
		return nil, err
	}
	return rc, nil
}

func (s *BackupService) DeleteRecipient(orgID, id string) error {
	return s.repo.DeleteRecipient(orgID, id)
}

// SetRestoreKey: la llave pública de restauración que generó el agente de un
// servidor. La privada nunca sale de ahí.
func (s *BackupService) SetRestoreKey(server *domain.Server, publicKey string) error {
	if !domain.ValidAgePublicKey(publicKey) {
		return ErrBadRecipient
	}
	return s.repo.SetServerRecipient(server.OrgID, server.ID, publicKey)
}

// ─── El agente ────────────────────────────────────────────────────────────────

// Claim: el siguiente trabajo de backup de ese servidor, si su agente sabe
// hacerlos. Un agente anterior no recibe nada: el trabajo espera en cola a que
// lo actualicen, en vez de perderse en un agente que no lo entiende.
func (s *BackupService) Claim(server *domain.Server) (*domain.AgentJob, error) {
	if server.AgentVersion < domain.AgentVersionBackups || !s.Enabled() {
		return nil, nil
	}
	b, err := s.repo.ClaimNext(server.ID, s.now())
	if err != nil || b == nil {
		return nil, err
	}
	s.publish(b.OrgID, "backup:status", b)
	t, err := s.repo.FindTarget(server.ID, b.TargetID)
	if err != nil {
		s.failNow(server.ID, b, "backup-target-gone")
		return nil, nil
	}
	keys, err := s.repo.Recipients(t.OrgID, t.ServerID)
	if err != nil {
		return nil, err
	}
	job := domain.BackupJob{
		BackupID: b.ID, Kind: b.Kind, ServiceName: t.ServiceName, Engine: t.Engine,
		Database: t.Database, CredentialEnv: t.CredentialEnv, Username: t.Username,
	}
	org := 0
	for _, k := range keys {
		job.Recipients = append(job.Recipients, k.PublicKey)
		if k.ServerID == "" {
			org++
		}
	}
	if b.Kind == domain.BackupKindRestoreTest {
		src, err := s.repo.FindBackup(server.ID, b.SourceBackupID)
		if err != nil || src.ObjectKey == "" {
			s.failNow(server.ID, b, ErrNothingToTest.Error())
			return nil, nil
		}
		job.SourceBackupID, job.SourceSha256 = src.ID, src.Sha256
	} else if org == 0 {
		// Sin una llave de la organización, nadie podría abrirlo nunca.
		s.failNow(server.ID, b, ErrNoRecipient.Error())
		return nil, nil
	}
	return &domain.AgentJob{ID: b.ID, Kind: "backup", Data: job}, nil
}

// failNow cierra como fallido uno que el backend no puede mandar.
func (s *BackupService) failNow(serverID string, b *domain.Backup, code string) {
	done, t, err := s.repo.Finish(serverID, b.ID, domain.AgentBackupFinishRequest{Status: domain.BackupFailed, Error: code}, s.now())
	if err == nil {
		s.finished(done, t)
	}
}

func (s *BackupService) AppendLog(serverID, id string, lines []string) error {
	b, err := s.repo.AppendLog(serverID, id, lines)
	if err != nil {
		return err
	}
	s.publish(b.OrgID, "backup:log", map[string]any{"backupId": id, "targetId": b.TargetID, "lines": lines})
	return nil
}

// UploadURL: el agente ya cifró el fichero; aquí se decide su clase y hasta
// cuándo se guarda, se apunta en la fila y se firma la subida con esa fecha.
func (s *BackupService) UploadURL(ctx context.Context, serverID, id string, req domain.AgentUploadURLRequest) (*domain.PresignedRequest, error) {
	if !s.Enabled() {
		return nil, ErrBackupsDisabled
	}
	b, t, err := s.repo.FindRunning(serverID, id)
	if err != nil {
		return nil, err
	}
	if b.Kind == domain.BackupKindRestoreTest {
		return nil, ErrNotABackupJob
	}
	now := s.now()
	class, until := domain.RetentionFor(*t, now, t.LastSuccessAt)
	key := domain.BackupObjectKey(s.store.Prefix(), b, t, now)
	if err := s.repo.SetObject(b.ID, key, req.SizeBytes, req.Sha256, until, class); err != nil {
		return nil, err
	}
	return s.store.PresignPut(ctx, key, req.SizeBytes, req.Sha256, until)
}

// DownloadURLForAgent: en una prueba de restauración, el backup a probar.
func (s *BackupService) DownloadURLForAgent(ctx context.Context, serverID, id string) (*domain.PresignedRequest, error) {
	if !s.Enabled() {
		return nil, ErrBackupsDisabled
	}
	b, _, err := s.repo.FindRunning(serverID, id)
	if err != nil {
		return nil, err
	}
	if b.Kind != domain.BackupKindRestoreTest {
		return nil, ErrNotABackupJob
	}
	src, err := s.repo.FindBackup(serverID, b.SourceBackupID)
	if err != nil || src.ObjectKey == "" || src.PurgedAt != nil {
		return nil, ErrNothingToTest
	}
	return s.store.PresignGet(ctx, src.ObjectKey, s.agentTTL)
}

func (s *BackupService) Finish(serverID, id string, req domain.AgentBackupFinishRequest) error {
	b, t, err := s.repo.Finish(serverID, id, req, s.now())
	if err != nil {
		return err
	}
	s.finished(b, t)
	return nil
}

// finished cuenta el cierre en vivo y avisa si falló.
func (s *BackupService) finished(b *domain.Backup, t *domain.BackupTarget) {
	s.publish(b.OrgID, "backup:status", b)
	if b.Status != domain.BackupFailed {
		return
	}
	key := "notify.backup.failed"
	if b.Kind == domain.BackupKindRestoreTest {
		key = "notify.backup.restoreFailed"
	}
	s.notifyAdmins(t, domain.BackupFailedKind(b.Kind), key, nil, b.Error)
}

func (s *BackupService) notifyAdmins(t *domain.BackupTarget, kind, titleKey string, extra map[string]string, body string) {
	if s.inbox == nil || s.orgs == nil || t == nil {
		return
	}
	admins, err := s.orgs.AdminIDs(t.OrgID)
	if err != nil {
		return
	}
	serverName := t.ServerID
	if s.servers != nil {
		if srv, err := s.servers.FindByID(t.ServerID); err == nil {
			serverName = srv.Name
		}
	}
	args := map[string]string{"db": t.Database, "server": serverName}
	for k, v := range extra {
		args[k] = v
	}
	seen := map[string]bool{}
	for _, uid := range admins {
		if uid == "" || seen[uid] {
			continue
		}
		seen[uid] = true
		s.inbox.Notify(domain.Aviso{
			UserID: uid, OrgID: t.OrgID, Kind: kind,
			TitleKey: titleKey, TitleArgs: args, Body: body,
			Link: "/servers/" + t.ServerID + "/backups?target=" + t.ID, Via: domain.ViaApp,
			Group: domain.BackupTargetGroup(t.ID), Label: t.Database,
		})
	}
}

// ─── El reloj ─────────────────────────────────────────────────────────────────

// FireDue es una vuelta del reloj. Con dos réplicas corre en las dos: cada
// paso se reserva con compare-and-swap, así que sólo una encola o avisa.
func (s *BackupService) FireDue(now time.Time) {
	if !s.Enabled() {
		return
	}
	// Los atascados primero: liberan el índice de un solo vivo por base.
	if expired, err := s.repo.ExpireStale(now); err == nil {
		for i := range expired {
			if t, err := s.repo.FindTarget(expired[i].ServerID, expired[i].TargetID); err == nil {
				s.finished(&expired[i], t)
			}
		}
	}
	if due, err := s.repo.DueTargets(now); err == nil {
		for i := range due {
			t := &due[i]
			next, err := domain.NextBackupRun(*t, now)
			if err != nil {
				continue
			}
			if won, err := s.repo.ReserveRun(t.ID, *t.NextRunAt, next); err != nil || !won {
				continue
			}
			// Uno vivo (uno a mano, o la prueba): éste se salta. El siguiente
			// ya está programado.
			_, _ = s.enqueue(t, domain.BackupKindScheduled, "", "")
		}
	}
	if due, err := s.repo.DueRestoreTests(now); err == nil {
		for i := range due {
			t := &due[i]
			next := now.Add(time.Duration(t.RestoreTestEveryDays) * 24 * time.Hour)
			if won, err := s.repo.ReserveRestoreTest(t.ID, *t.NextRestoreTestAt, next); err != nil || !won {
				continue
			}
			if src, err := s.repo.LastSucceeded(t.ID); err == nil {
				_, _ = s.enqueue(t, domain.BackupKindRestoreTest, "", src.ID)
			}
		}
	}
	if watched, err := s.repo.WatchedTargets(); err == nil {
		for i := range watched {
			t := &watched[i]
			since := t.CreatedAt
			if t.LastSuccessAt != nil {
				since = *t.LastSuccessAt
			}
			quiet := now.Sub(since)
			if quiet <= domain.BackupStaleAfterFor(*t) {
				continue
			}
			if won, err := s.repo.MarkStaleNotified(t.ID, now); err != nil || !won {
				continue
			}
			s.notifyAdmins(t, "backup:stale", "notify.backup.stale",
				map[string]string{"hours": strconv.Itoa(int(quiet.Hours()))}, "")
		}
	}
}

// Purge borra de S3 los objetos vencidos. Antes de su fecha S3 se niega (el
// Object Lock), y eso es lo que se quiere: el error se deja para otro día.
func (s *BackupService) Purge(ctx context.Context, now time.Time) (int, error) {
	if !s.Enabled() {
		return 0, nil
	}
	list, err := s.repo.Purgeable(now, 200)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, b := range list {
		if err := s.store.DeleteAllVersions(ctx, b.ObjectKey); err != nil {
			continue
		}
		if err := s.repo.MarkPurged(b.ID, now); err != nil {
			return n, fmt.Errorf("mark purged: %w", err)
		}
		n++
	}
	return n, nil
}
