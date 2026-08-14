package repository

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var DATABASE *gorm.DB

type contextKey string

const (
	UserContextKey   contextKey = "user"
	AccessRefreshKey contextKey = "refresh"
)

func DBConnection() {
	dsn := GetEnv("DATABASE_URL", "")
	lg.Info("En injected: " + dsn)
	if dsn == "" {
		dsn = buildDSN()
	}

	var db *gorm.DB
	var err error

	maxRetries := 10
	for i := range maxRetries {
		db, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
		if err == nil {
			break
		}
		fmt.Printf("DB connection attempt %d/%d failed: %v\n", i+1, maxRetries, err)
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		panic("failed to connect to database: " + err.Error())
	}

	// Bound connection age so pooled sockets don't go stale behind an idle LB /
	// NAT / conntrack timeout (a half-open conn would hang the next query).
	if sqlDB, dberr := db.DB(); dberr == nil {
		sqlDB.SetMaxOpenConns(20)
		sqlDB.SetMaxIdleConns(10)
		sqlDB.SetConnMaxIdleTime(5 * time.Minute)
		sqlDB.SetConnMaxLifetime(30 * time.Minute)
	}

	if err := db.AutoMigrate(
		&domain.User{},
		&domain.Organization{},
		&domain.OrgMembership{},
		&domain.OrgInvitation{},
		&domain.Server{},
		&domain.Collection{},
		&domain.CollectionNode{},
		&domain.CollectionShare{},
		&domain.ReportProject{},
		&domain.Report{},
		&domain.ReportComment{},
		&domain.ReportImage{},
		&domain.TelemetryEvent{},
		&domain.ServerIntegration{},
		&domain.PersonalAccessToken{},
		&domain.TaskSpace{},
		&domain.TaskFolder{},
		&domain.TaskList{},
		&domain.TaskStatus{},
		&domain.Task{},
		&domain.TaskTag{},
		&domain.TaskTagLink{},
		&domain.ItemAssignee{},
		&domain.TaskComment{},
		&domain.TaskAttachment{},
		&domain.Doc{},
		&domain.DocAttachment{},
		&domain.Note{},
		&domain.NoteAttachment{},
		&domain.NoteRevision{},
		// The unified model. Nothing reads these yet — see item_migration.go.
		&domain.ChatMessage{},
		&domain.ChatRead{},
		&domain.ChatAttachment{},
		&domain.Item{},
		&domain.ItemComment{},
		&domain.ItemAttachment{},
	); err != nil {
		panic("failed to run migrations: " + err.Error())
	}
	// An earlier revision of the model asked GORM for a unique index on the
	// idempotency key alone. That collides on the second task without a key —
	// which is every task — so drop it if a database already got it.
	if err := db.Exec(`DROP INDEX IF EXISTS idx_task_idem`).Error; err != nil {
		lg.Error("dropping the bad idempotency index: " + err.Error())
	}

	// A partial unique index: only rows that actually carry a key participate, so
	// the empty value every other task has doesn't collide. GORM's tags can't
	// express the WHERE clause, hence the raw statement.
	if err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
		ON tasks (list_id, idempotency_key) WHERE idempotency_key <> ''`).Error; err != nil {
		lg.Error("idempotency index: " + err.Error())
	}

	pss, err := HashPassword("ZMWmDcnawh3CQbJjMpPKoorTZv68jYuyzUojgvQpdJCmuUQ3mMNrDXiA2EKs7Jszv6uYjao8ds96uP2VU8CTKigEYZpdTDgZ78zn")
	if err != nil {
		panic("failed to hash seed password: " + err.Error())
	}
	lg.Info(pss)

	DATABASE = db
	seedAdmin(db)
	seedBaseOrg(db)
	promoteSuperadmin(db)
	backfillAttachmentRefs(db)
	migrateItems(db)
}

// backfillAttachmentRefs repoints attachments written before the proxy existed.
//
// They stored image-service's bucket URL, and the markdown that embeds them
// stored it too — but the bucket denies anonymous reads, so those images never
// rendered anywhere. This recovers the object key from the URL and rewrites both
// the row and every markdown reference to the proxy path. Idempotent: once
// rewritten, nothing matches the bucket-URL filter again.
func backfillAttachmentRefs(db *gorm.DB) {
	repairMismatchedRefs(db)

	var rows []domain.TaskAttachment
	if err := db.Where("url LIKE ?", "%amazonaws.com/%").Find(&rows).Error; err != nil {
		lg.Error("attachment backfill: query failed: " + err.Error())
		return
	}
	if len(rows) == 0 {
		return
	}

	fixed := 0
	for _, a := range rows {
		i := strings.Index(a.URL, "amazonaws.com/")
		key := strings.TrimPrefix(a.URL[i+len("amazonaws.com/"):], "/")
		if key == "" {
			continue
		}
		ref := domain.AttachmentRef(a.ItemID, a.ID)

		if err := db.Model(&domain.TaskAttachment{}).Where("id = ?", a.ID).
			Updates(map[string]any{"path": key, "url": ref}).Error; err != nil {
			lg.Error("attachment backfill: row " + a.ID + ": " + err.Error())
			continue
		}
		// Rewrite the exact old URL wherever the markdown embeds it.
		if err := db.Exec(
			"UPDATE tasks SET description = REPLACE(description, ?, ?) WHERE id = ? AND description LIKE ?",
			a.URL, ref, a.ItemID, "%"+a.URL+"%",
		).Error; err != nil {
			lg.Error("attachment backfill: description " + a.ItemID + ": " + err.Error())
		}
		if err := db.Exec(
			"UPDATE task_comments SET body = REPLACE(body, ?, ?) WHERE task_id = ? AND body LIKE ?",
			a.URL, ref, a.ItemID, "%"+a.URL+"%",
		).Error; err != nil {
			lg.Error("attachment backfill: comments " + a.ItemID + ": " + err.Error())
		}
		fixed++
	}
	lg.Info("attachment backfill: repointed " + strconv.Itoa(fixed) + " attachment(s) at the proxy")
}

const (
	baseOrgSlug = "dwit-mexico"
	baseOrgName = "Dwit México"
)

// legacyBaseOrgSlugs are names the base organization has had before, oldest
// first. Each is renamed **in place** so its memberships, servers, reports and
// projects follow — the row keeps its id, only the label changes.
//
// This list is what makes a rename safe: without it, changing the constants
// above would leave the old row untouched and create a second organization
// beside it, quietly splitting everything in two.
var legacyBaseOrgSlugs = []string{"default", "g-studio"}

// seedBaseOrg guarantees the base organization exists and owns any pre-org
// data, renaming it in place from whatever it used to be called (see
// legacyBaseOrgSlugs). Idempotent; safe on every boot.
//
// Unlike the old bridge, it does NOT auto-enroll every user: new users start
// with zero orgs and only see what they create or are invited to. It enrolls
// the seed admin so a fresh install has a usable owner.
func seedBaseOrg(db *gorm.DB) {
	var org domain.Organization

	// Carry every former name forward onto the current one.
	for _, old := range legacyBaseOrgSlugs {
		if err := db.Where("slug = ?", old).First(&org).Error; err != nil {
			continue
		}
		if err := db.Model(&org).Updates(map[string]any{"name": baseOrgName, "slug": baseOrgSlug}).Error; err != nil {
			lg.Error("rename base org from " + old + " failed: " + err.Error())
		} else {
			lg.Info(`organization "` + old + `" renamed to "` + baseOrgName + `"`)
		}
	}

	// Ensure the base org exists (fresh installs, or if the legacy one was gone).
	err := db.Where("slug = ?", baseOrgSlug).First(&org).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		org = domain.Organization{Name: baseOrgName}
		org.Slug = baseOrgSlug
		org.ID = uuid.NewString()
		if err := db.Create(&org).Error; err != nil {
			lg.Error("seed base org failed: " + err.Error())
			return
		}
		lg.Info("base organization seeded: " + baseOrgName)
	} else if err != nil {
		lg.Error("seed base org lookup failed: " + err.Error())
		return
	}

	// Enroll the seed admin (only) as owner-admin so a fresh install is usable.
	admin := GetEnv("ADMIN_USERNAME", "admin")
	var au domain.User
	if err := db.Where("username = ?", admin).First(&au).Error; err == nil {
		var count int64
		db.Model(&domain.OrgMembership{}).Where("user_id = ?", au.ID).Count(&count)
		if count == 0 {
			db.Create(&domain.OrgMembership{OrgID: org.ID, UserID: au.ID, Role: domain.OrgRoleAdmin})
		}
	}

	// Backfill servers registered before org scoping existed.
	db.Model(&domain.Server{}).
		Where("org_id IS NULL OR org_id = ''").
		Update("org_id", org.ID)

	// Backfill the report-project platform column for projects created before it
	// existed (all pre-existing projects are browser/widget projects).
	db.Model(&domain.ReportProject{}).
		Where("platform IS NULL OR platform = ''").
		Update("platform", "web")
}

// promoteSuperadmin marks the seed admin as a platform superadmin (sees/manages
// ALL orgs). Idempotent; migrates existing installs where the flag is new.
func promoteSuperadmin(db *gorm.DB) {
	admin := GetEnv("ADMIN_USERNAME", "admin")
	if err := db.Model(&domain.User{}).
		Where("username = ?", admin).
		Update("is_superadmin", true).Error; err != nil {
		lg.Error("promote superadmin failed: " + err.Error())
	}
}

// buildDSN constructs a DSN from individual env vars as fallback.
func buildDSN() string {
	host := GetEnv("DB_HOST", "localhost")
	port := GetEnv("DB_PORT", "5432")
	user := GetEnv("DB_USER", "postgres")
	password := GetEnv("DB_PASSWORD", "")
	name := GetEnv("DB_NAME", "cac")
	sslmode := GetEnv("DB_SSLMODE", "disable")
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=%s", host, port, user, password, name, sslmode)
}

func seedAdmin(db *gorm.DB) {
	var count int64
	db.Model(&domain.User{}).Count(&count)
	if count > 0 {
		return
	}

	password := GetEnv("ADMIN_PASSWORD", "admin1234")
	hashed, err := HashPassword(password)
	if err != nil {
		fmt.Println("Error hashing seed password:", err)
		return
	}

	admin := domain.User{
		Username: GetEnv("ADMIN_USERNAME", "admin"),
		Password: hashed,
	}
	admin.ID = uuid.NewString()

	if err := db.Create(&admin).Error; err != nil {
		fmt.Println("Error seeding admin user:", err)
	} else {
		fmt.Println("Admin user seeded successfully")
	}
}

// repairMismatchedRefs fixes rows whose URL embeds an attachment id that does
// not exist: the upload handler minted an id to build the URL and the service
// then replaced it before inserting, so the proxy looked up a phantom row and
// answered 404 for every image. The row is authoritative, so the URL — and every
// markdown reference to it — is rewritten to the row's own id.
func repairMismatchedRefs(db *gorm.DB) {
	var rows []domain.TaskAttachment
	if err := db.Where("url LIKE ?", "/api/v1/tasks/%/attachments/%/raw").Find(&rows).Error; err != nil {
		lg.Error("attachment repair: query failed: " + err.Error())
		return
	}

	fixed := 0
	for _, a := range rows {
		want := domain.AttachmentRef(a.ItemID, a.ID)
		if a.URL == want {
			continue
		}
		old := a.URL
		if err := db.Model(&domain.TaskAttachment{}).Where("id = ?", a.ID).
			Update("url", want).Error; err != nil {
			lg.Error("attachment repair: row " + a.ID + ": " + err.Error())
			continue
		}
		if err := db.Exec(
			"UPDATE tasks SET description = REPLACE(description, ?, ?) WHERE id = ? AND description LIKE ?",
			old, want, a.ItemID, "%"+old+"%",
		).Error; err != nil {
			lg.Error("attachment repair: description " + a.ItemID + ": " + err.Error())
		}
		if err := db.Exec(
			"UPDATE task_comments SET body = REPLACE(body, ?, ?) WHERE task_id = ? AND body LIKE ?",
			old, want, a.ItemID, "%"+old+"%",
		).Error; err != nil {
			lg.Error("attachment repair: comments " + a.ItemID + ": " + err.Error())
		}
		fixed++
	}
	if fixed > 0 {
		lg.Info("attachment repair: fixed " + strconv.Itoa(fixed) + " reference(s) pointing at a phantom id")
	}
}
