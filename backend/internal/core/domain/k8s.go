package domain

import "time"

// ─── Platform hub (kubernetes server) responses ───────────────────────────────

type K8sGateway struct {
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	Address    string `json:"address"`
	Programmed bool   `json:"programmed"`
}

type K8sRoute struct {
	Name       string     `json:"name"`
	Namespace  string     `json:"namespace"`
	Gateway    string     `json:"gateway"`
	Hostnames  []string   `json:"hostnames"`
	Links      []string   `json:"links"`               // https://<host> per hostname
	CertReady  *bool      `json:"certReady,omitempty"` // nil = no matching cert found
	CertExpiry *time.Time `json:"certExpiry,omitempty"`
}

// K8sRoutesResponse powers the "directory" tiles + gateway status.
type K8sRoutesResponse struct {
	Gateways []K8sGateway `json:"gateways"`
	Routes   []K8sRoute   `json:"routes"`
}

type K8sNode struct {
	Name           string `json:"name"`
	KubeletVersion string `json:"kubeletVersion"`
	Ready          bool   `json:"ready"`
}

type K8sWorkload struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Ready     int    `json:"ready"`
	Desired   int    `json:"desired"`
	Healthy   bool   `json:"healthy"`
}

type K8sCert struct {
	Name      string     `json:"name"`
	Namespace string     `json:"namespace"`
	DNSNames  []string   `json:"dnsNames"`
	NotAfter  *time.Time `json:"notAfter,omitempty"`
	DaysLeft  *int       `json:"daysLeft,omitempty"`
	Ready     bool       `json:"ready"`
}

type K8sDatastore struct {
	Kind      string `json:"kind"` // "postgres-cnpg"
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Instances int    `json:"instances"`
	Ready     int    `json:"ready"`
	Phase     string `json:"phase"`
	Healthy   bool   `json:"healthy"`
}

// K8sHealth is the cluster health strip: nodes, workloads, certs, datastores.
type K8sHealth struct {
	Nodes      []K8sNode      `json:"nodes"`
	Workloads  []K8sWorkload  `json:"workloads"`
	Certs      []K8sCert      `json:"certs"`
	Datastores []K8sDatastore `json:"datastores"`
}
