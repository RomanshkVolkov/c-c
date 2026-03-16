package repository

import (
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

	if err := db.AutoMigrate(&domain.User{}, &domain.Server{}); err != nil {
		panic("failed to run migrations: " + err.Error())
	}

	DATABASE = db
	seedAdmin(db)
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
