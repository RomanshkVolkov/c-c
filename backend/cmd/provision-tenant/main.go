// provision-tenant wires up one external app as a cac reports tenant and
// prints the credentials it needs, once.
//
// Why a command and not the console: a tenant is not one object. It's an
// organization, a service user that belongs to it, and one or more report
// projects with the right platform and rate limit — and every credential is
// shown exactly once at creation. Doing that by hand for each app is where a
// step gets skipped: a project left on the default 20 reports/hour throttles
// silently, and a project created as "web" refuses a server-to-server caller
// the moment an Origin header appears.
//
// It is idempotent by name: re-running finds what already exists instead of
// making a second copy. Secrets are only printed for what it actually creates,
// because they aren't recoverable afterwards — to get a new ingest key later,
// rotate it from the console.
//
//	go run ./cmd/provision-tenant -org "Portento" -app portento
//	go run ./cmd/provision-tenant -org "Portento" -app portento -webhook https://…/api/webhooks/cac-reports
//
// Add -system to also create a separate project for automated reports, so a
// burst of sync failures can't eat the humans' rate limit.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
	"gorm.io/gorm"
)

func main() {
	var (
		orgName   = flag.String("org", "", "organization name (created if it doesn't exist)")
		app       = flag.String("app", "", "tenant slug, e.g. portento — names the project and the service user")
		webhook   = flag.String("webhook", "", "optional URL to POST report events to")
		rateLimit = flag.Int("rate-limit", 500, "reports per hour, per project")
		system    = flag.Bool("system", false, "also create a separate project for automated reports")
	)
	flag.Parse()
	if *orgName == "" || *app == "" {
		fmt.Fprintln(os.Stderr, "usage: provision-tenant -org <name> -app <slug> [-webhook url] [-system]")
		flag.PrintDefaults()
		os.Exit(2)
	}

	repository.LoadEnv()
	repository.DBConnection()
	db := repository.DATABASE

	out := &report{}
	orgID, err := ensureOrg(db, *orgName)
	if err != nil {
		fail("organization", err)
	}
	out.orgID = orgID

	user, password, err := ensureServiceUser(db, *app, orgID)
	if err != nil {
		fail("service user", err)
	}
	out.serviceUser, out.servicePassword = user, password

	secret := ""
	if *webhook != "" {
		secret = randomSecret()
	}
	projects := []struct{ name, slug string }{{*app + " (users)", *app}}
	if *system {
		projects = append(projects, struct{ name, slug string }{*app + " (system)", *app + "-system"})
	}
	for _, p := range projects {
		id, key, created, err := ensureProject(db, orgID, p.name, p.slug, *webhook, secret, *rateLimit)
		if err != nil {
			fail("project "+p.slug, err)
		}
		out.projects = append(out.projects, projectOut{slug: p.slug, id: id, ingestKey: key, created: created})
	}
	out.webhookURL, out.webhookSecret = *webhook, secret
	out.print()
}

func fail(what string, err error) {
	fmt.Fprintf(os.Stderr, "\n%s: %v\n", what, err)
	os.Exit(1)
}

// ensureOrg returns the id of the org with this name, creating it if absent.
func ensureOrg(db *gorm.DB, name string) (string, error) {
	var org domain.Organization
	err := db.Where("name = ?", name).First(&org).Error
	if err == nil {
		return org.ID, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return "", err
	}
	org = domain.Organization{Name: name, Slug: slugify(name)}
	org.ID = uuid.NewString()
	if err := db.Create(&org).Error; err != nil {
		return "", err
	}
	return org.ID, nil
}

// ensureServiceUser returns the tenant's service account, creating it with a
// fresh password if it doesn't exist yet. The password comes back only on
// creation — it is not stored in a recoverable form.
//
// The account is a member, not an admin: it has to file and triage reports,
// not manage the organization.
func ensureServiceUser(db *gorm.DB, app, orgID string) (username, password string, err error) {
	username = "svc-" + app
	orgRepo := repository.NewOrganizationRepository(db)

	var u domain.User
	switch err = db.Where("username = ?", username).First(&u).Error; {
	case err == nil:
		// Already there — make sure it still belongs to the org, then leave the
		// password alone. Rotating it here would break whatever is using it.
		return username, "", orgRepo.UpsertMember(orgID, u.ID, domain.OrgRoleMember)
	case !errors.Is(err, gorm.ErrRecordNotFound):
		return "", "", err
	}

	password = randomSecret()
	hashed, err := repository.HashPassword(password)
	if err != nil {
		return "", "", err
	}
	u = domain.User{
		Username: username,
		Password: hashed,
		Name:     app + " service account",
		// No forced password change: nobody logs in interactively as this
		// account, and the flag would lock the integration out on first use.
		MustChangePassword: false,
	}
	u.ID = uuid.NewString()
	if err := repository.NewAuthRepository(db).CreateUser(&u); err != nil {
		return "", "", err
	}
	return username, password, orgRepo.UpsertMember(orgID, u.ID, domain.OrgRoleMember)
}

// ensureProject creates the report project if its slug is free. platform="app"
// is deliberate: a server-to-server caller sends no Origin header, and "web"
// exists to police one.
func ensureProject(db *gorm.DB, orgID, name, slug, webhook, secret string, rate int) (id, ingestKey string, created bool, err error) {
	var existing domain.ReportProject
	switch err = db.Where("slug = ?", slug).First(&existing).Error; {
	case err == nil:
		return existing.ID, "", false, nil
	case !errors.Is(err, gorm.ErrRecordNotFound):
		return "", "", false, err
	}

	svc := service.NewReportProjectService(
		repository.NewReportProjectRepository(db),
		repository.NewOrganizationRepository(db),
	)
	res, err := svc.Create(domain.CreateReportProjectRequest{
		OrgID:            orgID,
		Name:             name,
		Slug:             slug,
		Platform:         "app",
		RateLimitPerHour: rate,
		WebhookURL:       webhook,
		WebhookSecret:    secret,
	})
	if err != nil {
		return "", "", false, err
	}
	return res.Project.ID, res.IngestKey, true, nil
}

func randomSecret() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic("no entropy: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func slugify(s string) string {
	var out []rune
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			out = append(out, r)
		case r == ' ' || r == '-' || r == '_':
			out = append(out, '-')
		}
	}
	return strings.Trim(string(out), "-")
}

// ─── Output ──────────────────────────────────────────────────────────────────

type projectOut struct {
	slug, id, ingestKey string
	created             bool
}

type report struct {
	orgID                        string
	serviceUser, servicePassword string
	webhookURL, webhookSecret    string
	projects                     []projectOut
}

func (r *report) print() {
	base := repository.GetEnv("PUBLIC_BASE_URL", "https://cac.guz-studio.dev")
	fmt.Println("\n─── tenant provisioned ──────────────────────────────────────")
	fmt.Println("CAC_BASE_URL=" + base)
	fmt.Println("CAC_ORG_ID=" + r.orgID)
	for i, p := range r.projects {
		suffix := ""
		if i > 0 {
			suffix = "_SYSTEM"
		}
		fmt.Printf("CAC_PROJECT_ID%s=%s   # %s\n", suffix, p.id, p.slug)
		if p.created {
			fmt.Printf("CAC_INGEST_KEY%s=%s\n", suffix, p.ingestKey)
		} else {
			fmt.Printf("CAC_INGEST_KEY%s=<existed already — rotate from the console to get one>\n", suffix)
		}
	}
	fmt.Println("CAC_SERVICE_USER=" + r.serviceUser)
	if r.servicePassword != "" {
		fmt.Println("CAC_SERVICE_PASSWORD=" + r.servicePassword)
	} else {
		fmt.Println("CAC_SERVICE_PASSWORD=<existed already — reset it from the console>")
	}
	if r.webhookURL != "" {
		fmt.Println("CAC_WEBHOOK_SECRET=" + r.webhookSecret)
	}
	fmt.Println("─────────────────────────────────────────────────────────────")
	fmt.Println("Copy these now: the ingest key and the password are not recoverable.")
}
