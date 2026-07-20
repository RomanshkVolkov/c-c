package repository

import (
	"errors"
	"fmt"
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

	if err := db.AutoMigrate(
		&domain.User{},
		&domain.Organization{},
		&domain.OrgMembership{},
		&domain.Server{},
		&domain.Collection{},
		&domain.CollectionNode{},
		&domain.CollectionShare{},
		&domain.ReportProject{},
		&domain.Report{},
		&domain.ReportComment{},
		&domain.ReportImage{},
	); err != nil {
		panic("failed to run migrations: " + err.Error())
	}
	pss, err := HashPassword("ZMWmDcnawh3CQbJjMpPKoorTZv68jYuyzUojgvQpdJCmuUQ3mMNrDXiA2EKs7Jszv6uYjao8ds96uP2VU8CTKigEYZpdTDgZ78zn")
	if err != nil {
		panic("failed to hash seed password: " + err.Error())
	}
	lg.Info(pss)

	DATABASE = db
	seedAdmin(db)
	seedDefaultOrg(db)
}

// seedDefaultOrg guarantees a "default" organization exists, enrolls every
// user that has no membership yet as its admin, and backfills any server that
// predates the org column. Idempotent — safe to run on every boot. This is the
// single-tenant → multi-tenant bridge from the organizations proposal.
func seedDefaultOrg(db *gorm.DB) {
	const defaultSlug = "default"

	var org domain.Organization
	err := db.Where("slug = ?", defaultSlug).First(&org).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		org = domain.Organization{Name: "Default"}
		org.Slug = defaultSlug
		org.ID = uuid.NewString()
		if err := db.Create(&org).Error; err != nil {
			lg.Error("seed default org failed: " + err.Error())
			return
		}
		lg.Info("default organization seeded")
	} else if err != nil {
		lg.Error("seed default org lookup failed: " + err.Error())
		return
	}

	// Enroll users without any membership as admins of the default org.
	var users []domain.User
	if err := db.Find(&users).Error; err != nil {
		lg.Error("seed default org: list users failed: " + err.Error())
		return
	}
	for _, u := range users {
		var count int64
		db.Model(&domain.OrgMembership{}).Where("user_id = ?", u.ID).Count(&count)
		if count == 0 {
			db.Create(&domain.OrgMembership{OrgID: org.ID, UserID: u.ID, Role: domain.OrgRoleAdmin})
		}
	}

	// Backfill servers registered before org scoping existed.
	db.Model(&domain.Server{}).
		Where("org_id IS NULL OR org_id = ''").
		Update("org_id", org.ID)
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
