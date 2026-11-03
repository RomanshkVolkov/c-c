package repository

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// IncidentRepository: el registro de lo que mordió (domain.Incident).
type IncidentRepository struct{ db *gorm.DB }

func NewIncidentRepository(db *gorm.DB) *IncidentRepository { return &IncidentRepository{db: db} }

// ServerMatch: un servidor de la org, por su id o por su nombre.
type ServerMatch struct{ ID, Name string }

// OrgServers: los servidores de una org, por nombre. Para resolver lo que
// nombra quien apunta un incidente, y para decirle cuáles hay si se equivoca.
func (r *IncidentRepository) OrgServers(orgID string) ([]ServerMatch, error) {
	var out []ServerMatch
	err := r.db.Table("servers").Select("id, name").Where("org_id = ?", orgID).Order("name").Scan(&out).Error
	return out, err
}

// CommitLink: lo que cac ya sabe de un commit de la org, si lo vio nombrar una
// tarea. El sha puede venir corto.
func (r *IncidentRepository) CommitLink(orgID, repoName, sha string) (repo, fullSHA, title, url string) {
	var row struct{ RepoFullName, Key, Title, HTMLURL string }
	q := r.db.Table("task_git_links").Select("repo_full_name, key, title, html_url").
		Where("org_id = ? AND kind = 'commit' AND key LIKE ?", orgID, sha+"%")
	if repoName != "" {
		q = q.Where("lower(repo_full_name) = lower(?)", repoName)
	}
	q.Order("occurred_at DESC").Limit(1).Scan(&row)
	return row.RepoFullName, row.Key, row.Title, row.HTMLURL
}

// Create guarda un incidente con lo que lo ata, en una transacción: no puede
// quedar escrito sin los servidores de los que dice hablar.
func (r *IncidentRepository) Create(in *domain.Incident, serverIDs, areas []string,
	commits []domain.IncidentCommit, guards []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		in.ID = uuid.NewString()
		if in.Status == "" {
			in.Status = domain.IncidentOpen
		}
		if in.Status == domain.IncidentFixed && in.FixedAt == nil {
			now := time.Now()
			in.FixedAt = &now
		}
		if err := tx.Create(in).Error; err != nil {
			return err
		}
		return addTo(tx, in.ID, serverIDs, areas, commits, guards)
	})
}

// Add le añade servidores, áreas, commits y guardianes. Lo que ya tenía no se
// repite.
func (r *IncidentRepository) Add(id string, serverIDs, areas []string,
	commits []domain.IncidentCommit, guards []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := addTo(tx, id, serverIDs, areas, commits, guards); err != nil {
			return err
		}
		return tx.Model(&domain.Incident{}).Where("id = ?", id).Update("updated_at", time.Now()).Error
	})
}

func addTo(tx *gorm.DB, id string, serverIDs, areas []string, commits []domain.IncidentCommit, guards []string) error {
	ignore := clause.OnConflict{DoNothing: true}
	for _, s := range serverIDs {
		if err := tx.Clauses(ignore).Create(&domain.IncidentServer{IncidentID: id, ServerID: s}).Error; err != nil {
			return err
		}
	}
	for _, a := range areas {
		if err := tx.Clauses(ignore).Create(&domain.IncidentArea{IncidentID: id, Area: a}).Error; err != nil {
			return err
		}
	}
	for _, c := range commits {
		c.ID, c.IncidentID = uuid.NewString(), id
		if err := tx.Clauses(ignore).Create(&c).Error; err != nil {
			return err
		}
	}
	for _, g := range guards {
		if err := tx.Clauses(ignore).Create(&domain.IncidentGuard{ID: uuid.NewString(), IncidentID: id, Text: g}).Error; err != nil {
			return err
		}
	}
	return refreshKeywords(tx, id)
}

// refreshKeywords pone en `keywords` los nombres de sus servidores y sus
// áreas, que es lo que los mete en la búsqueda (ver search_index.go).
func refreshKeywords(tx *gorm.DB, id string) error {
	var names, areas []string
	if err := tx.Table("incident_servers isv").Select("s.name").Joins("JOIN servers s ON s.id = isv.server_id").
		Where("isv.incident_id = ?", id).Order("s.name").Pluck("s.name", &names).Error; err != nil {
		return err
	}
	if err := tx.Model(&domain.IncidentArea{}).Where("incident_id = ?", id).Order("area").Pluck("area", &areas).Error; err != nil {
		return err
	}
	return tx.Model(&domain.Incident{}).Where("id = ?", id).Update("keywords", domain.IncidentKeywords(names, areas)).Error
}

// SetStatus mueve el estado; `fixed_at` sigue al estado.
func (r *IncidentRepository) SetStatus(id string, st domain.IncidentStatus) error {
	upd := map[string]any{"status": st, "updated_at": time.Now()}
	if st == domain.IncidentFixed {
		upd["fixed_at"] = time.Now()
	} else {
		upd["fixed_at"] = nil
	}
	return r.db.Model(&domain.Incident{}).Where("id = ?", id).Updates(upd).Error
}

// Raw: la fila, sin resolver nada. "" en OrgID si no existe.
func (r *IncidentRepository) Raw(id string) (*domain.Incident, error) {
	var in domain.Incident
	if err := r.db.Where("id = ?", id).First(&in).Error; err != nil {
		return nil, err
	}
	return &in, nil
}

// IsSuperseded: si algún incidente dice sustituir a éste.
func (r *IncidentRepository) IsSuperseded(id string) bool {
	var n int64
	r.db.Model(&domain.Incident{}).Where("supersedes_id = ?", id).Count(&n)
	return n > 0
}

// ByID: un incidente entero, con todo lo que lo ata resuelto.
func (r *IncidentRepository) ByID(id string) (*domain.Incident, error) {
	in, err := r.Raw(id)
	if err != nil {
		return nil, err
	}
	var owner struct {
		OwnerKind domain.DocOwnerKind
		OwnerID   string
	}
	r.db.Table("docs").Select("owner_kind, owner_id").Where("id = ?", in.DocID).Scan(&owner)
	in.OwnerKind, in.OwnerID = owner.OwnerKind, owner.OwnerID
	in.OwnerName = r.nodeName(owner.OwnerKind, owner.OwnerID)
	r.db.Table("users").Select(nombreVisible).Where("id = ?", in.AuthorID).Scan(&in.AuthorName)
	if in.OriginTaskID != "" {
		in.OriginTitle, in.OriginRef = r.taskRef(in.OriginTaskID)
	}
	r.db.Model(&domain.Incident{}).Select("id").Where("supersedes_id = ?", in.ID).Limit(1).Scan(&in.SupersededByID)
	l, err := r.links([]string{in.ID})
	if err != nil {
		return nil, err
	}
	in.Servers, in.Areas, in.Guards = orEmptyServers(l.servers[in.ID]), orEmptyStrings(l.areas[in.ID]), orEmptyStrings(l.guards[in.ID])
	in.Commits = []domain.IncidentCommit{}
	if err := r.db.Where("incident_id = ?", in.ID).Order("created_at").Find(&in.Commits).Error; err != nil {
		return nil, err
	}
	return in, nil
}

func (r *IncidentRepository) nodeName(kind domain.DocOwnerKind, id string) string {
	table := map[domain.DocOwnerKind]string{
		domain.DocOwnerSpace: "task_spaces", domain.DocOwnerFolder: "task_folders", domain.DocOwnerList: "task_lists",
	}[kind]
	if table == "" {
		return ""
	}
	var name string
	r.db.Table(table).Select("name").Where("id = ?", id).Scan(&name)
	return name
}

// taskRef: el título y la referencia (`clave-número`) de una tarea interna.
// Una de un cliente sale sin referencia: su folio no es de este espacio.
func (r *IncidentRepository) taskRef(taskID string) (title, ref string) {
	var row struct {
		Title, ProjectID, Key string
		Seq                   int
	}
	r.db.Table("items i").Select("i.title, i.project_id, i.seq, COALESCE(sp.key, '') AS key").
		Joins("LEFT JOIN task_lists l ON l.id = i.list_id").
		Joins("LEFT JOIN task_spaces sp ON sp.id = l.space_id").
		Where("i.id = ?", taskID).Scan(&row)
	if row.ProjectID == "" {
		ref = domain.SpaceTaskRef(row.Key, row.Seq)
	}
	return row.Title, ref
}

// incidentLinks: los servidores, las áreas y los guardianes de varios
// incidentes, por id.
type incidentLinks struct {
	servers map[string][]domain.IncidentServerRef
	areas   map[string][]string
	guards  map[string][]string
}

// links: ver incidentLinks, en tres consultas.
func (r *IncidentRepository) links(ids []string) (*incidentLinks, error) {
	servers := map[string][]domain.IncidentServerRef{}
	areas := map[string][]string{}
	guards := map[string][]string{}
	out := &incidentLinks{servers: servers, areas: areas, guards: guards}
	if len(ids) == 0 {
		return out, nil
	}
	var srows []struct{ IncidentID, ID, Name string }
	if err := r.db.Table("incident_servers isv").Select("isv.incident_id, s.id, s.name").
		Joins("JOIN servers s ON s.id = isv.server_id").Where("isv.incident_id IN ?", ids).
		Order("s.name").Scan(&srows).Error; err != nil {
		return nil, err
	}
	for _, x := range srows {
		servers[x.IncidentID] = append(servers[x.IncidentID], domain.IncidentServerRef{ID: x.ID, Name: x.Name})
	}
	var arows []domain.IncidentArea
	if err := r.db.Where("incident_id IN ?", ids).Order("area").Find(&arows).Error; err != nil {
		return nil, err
	}
	for _, x := range arows {
		areas[x.IncidentID] = append(areas[x.IncidentID], x.Area)
	}
	var grows []domain.IncidentGuard
	if err := r.db.Where("incident_id IN ?", ids).Order("created_at").Find(&grows).Error; err != nil {
		return nil, err
	}
	for _, x := range grows {
		guards[x.IncidentID] = append(guards[x.IncidentID], x.Text)
	}
	return out, nil
}

// List: los incidentes vigentes (no sustituidos) que pasan el filtro, los
// abiertos primero y luego los más recientes. Uno más del límite, para saber si
// se recortó.
func (r *IncidentRepository) List(f domain.IncidentFilter) ([]domain.IncidentSummary, error) {
	out := []domain.IncidentSummary{}
	if len(f.OrgIDs) == 0 {
		return out, nil
	}
	limit := f.Limit
	if limit <= 0 || limit > domain.IncidentListMax {
		limit = domain.IncidentListMax
	}
	q := r.db.Table("incidents inc").
		Select("inc.id, inc.title, inc.status, inc.org_id, d.owner_kind, d.owner_id, inc.created_at, inc.fixed_at").
		Joins("JOIN docs d ON d.id = inc.doc_id").
		Where("inc.org_id IN ?", f.OrgIDs).
		Where("NOT EXISTS (SELECT 1 FROM incidents n WHERE n.supersedes_id = inc.id)")
	if f.SpaceID != "" {
		q = q.Where(`(d.owner_kind = 'space' AND d.owner_id = ?)
			OR (d.owner_kind = 'folder' AND d.owner_id IN (SELECT id FROM task_folders WHERE space_id = ?))
			OR (d.owner_kind = 'list' AND d.owner_id IN (SELECT id FROM task_lists WHERE space_id = ?))`,
			f.SpaceID, f.SpaceID, f.SpaceID)
	}
	if f.Node != "" {
		q = q.Where("d.owner_id = ?", f.Node)
	}
	if s := strings.TrimSpace(f.Server); s != "" {
		q = q.Where(`EXISTS (SELECT 1 FROM incident_servers is2 JOIN servers s ON s.id = is2.server_id
			WHERE is2.incident_id = inc.id AND (s.id = ? OR lower(s.name) = lower(?)))`, s, s)
	}
	if a := domain.NormalizeIncidentArea(f.Area); a != "" {
		q = q.Where("EXISTS (SELECT 1 FROM incident_areas ia WHERE ia.incident_id = inc.id AND ia.area = ?)", a)
	}
	if f.Status != "" {
		q = q.Where("inc.status = ?", f.Status)
	}
	if f.Since != nil {
		q = q.Where("inc.updated_at > ?", *f.Since)
	}
	// El orden con una sola expresión: dos `Order()` de GORM, el de columna
	// simple pisa al anterior.
	q = q.Order("CASE WHEN inc.status = 'open' THEN 0 ELSE 1 END, inc.created_at DESC").Limit(limit + 1)
	if err := q.Scan(&out).Error; err != nil {
		return nil, err
	}
	ids := make([]string, len(out))
	for i := range out {
		ids[i] = out[i].ID
	}
	l, err := r.links(ids)
	if err != nil {
		return nil, err
	}
	// Si su arreglo ya salió en una release: un extra, sin él no se cae.
	shipped, _ := ShippedOfIncidents(r.db, ids)
	for i := range out {
		out[i].Servers = orEmptyServers(l.servers[out[i].ID])
		out[i].Areas = orEmptyStrings(l.areas[out[i].ID])
		out[i].Guards = orEmptyStrings(l.guards[out[i].ID])
		out[i].Shipped = shipped[out[i].ID]
	}
	return out, nil
}

// ForDocs: los vigentes de varios documentos, para el mapa de contexto.
func (r *IncidentRepository) ForDocs(orgID string, docIDs []string) (map[string][]domain.IncidentSummary, error) {
	byDoc := map[string][]domain.IncidentSummary{}
	if len(docIDs) == 0 {
		return byDoc, nil
	}
	var rows []struct {
		DocID string
		domain.IncidentSummary
	}
	err := r.db.Table("incidents inc").
		Select("inc.doc_id, inc.id, inc.title, inc.status, inc.org_id, inc.created_at, inc.fixed_at").
		Where("inc.org_id = ? AND inc.doc_id IN ?", orgID, docIDs).
		Where("NOT EXISTS (SELECT 1 FROM incidents n WHERE n.supersedes_id = inc.id)").
		Order("CASE WHEN inc.status = 'open' THEN 0 ELSE 1 END, inc.created_at DESC").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(rows))
	for i := range rows {
		ids[i] = rows[i].ID
	}
	l, err := r.links(ids)
	if err != nil {
		return nil, err
	}
	shipped, _ := ShippedOfIncidents(r.db, ids)
	for _, x := range rows {
		s := x.IncidentSummary
		s.Servers, s.Areas, s.Guards = orEmptyServers(l.servers[s.ID]), orEmptyStrings(l.areas[s.ID]), orEmptyStrings(l.guards[s.ID])
		s.Shipped = shipped[s.ID]
		byDoc[x.DocID] = append(byDoc[x.DocID], s)
	}
	return byDoc, nil
}

func orEmptyServers(l []domain.IncidentServerRef) []domain.IncidentServerRef {
	if l == nil {
		return []domain.IncidentServerRef{}
	}
	return l
}

func orEmptyStrings(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}
