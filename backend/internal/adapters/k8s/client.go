// Package k8s is a tiny read-only client against the in-cluster Kubernetes API
// server. It uses the pod's ServiceAccount token + CA (no client-go dependency)
// and only issues GET/list — enough to power the platform hub (nodes, workloads,
// Gateway API routes, cert-manager certs, CNPG clusters).
package k8s

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"
)

const (
	tokenFile = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	caFile    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

var ErrUnavailable = errors.New("kubernetes API not available (not running in-cluster)")

type Client struct {
	base    string
	token   string
	http    *http.Client
	enabled bool
}

// New builds the client from the in-cluster environment. When not running in a
// pod (local dev) it returns a disabled client whose calls yield ErrUnavailable.
func New() *Client {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return &Client{enabled: false}
	}
	token, err := os.ReadFile(tokenFile)
	if err != nil {
		return &Client{enabled: false}
	}
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return &Client{enabled: false}
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return &Client{enabled: false}
	}
	return &Client{
		base:  fmt.Sprintf("https://%s:%s", host, port),
		token: string(token),
		http: &http.Client{
			Timeout:   10 * time.Second,
			Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
		},
		enabled: true,
	}
}

func (c *Client) Enabled() bool { return c.enabled }

// getInto GETs a path and decodes the JSON body into out.
func (c *Client) getInto(ctx context.Context, path string, out any) error {
	if !c.enabled {
		return ErrUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusForbidden || res.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("k8s API %s: %s (check cac-hub RBAC)", path, res.Status)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("k8s API %s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// ─── minimal typed views (only the fields the hub renders) ────────────────────

type meta struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}
type condition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

func condStatus(conds []condition, t string) string {
	for _, c := range conds {
		if c.Type == t {
			return c.Status
		}
	}
	return ""
}

type NodeInfo struct {
	Name       string
	KubeletVer string
	Ready      bool
}

func (c *Client) Nodes(ctx context.Context) ([]NodeInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Status   struct {
				NodeInfo struct {
					KubeletVersion string `json:"kubeletVersion"`
				} `json:"nodeInfo"`
				Conditions []condition `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/api/v1/nodes", &resp); err != nil {
		return nil, err
	}
	out := make([]NodeInfo, 0, len(resp.Items))
	for _, n := range resp.Items {
		out = append(out, NodeInfo{
			Name:       n.Metadata.Name,
			KubeletVer: n.Status.NodeInfo.KubeletVersion,
			Ready:      condStatus(n.Status.Conditions, "Ready") == "True",
		})
	}
	return out, nil
}

type WorkloadInfo struct {
	Name      string
	Namespace string
	Ready     int
	Desired   int
}

func (c *Client) Deployments(ctx context.Context) ([]WorkloadInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Spec     struct {
				Replicas int `json:"replicas"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/apis/apps/v1/deployments", &resp); err != nil {
		return nil, err
	}
	out := make([]WorkloadInfo, 0, len(resp.Items))
	for _, d := range resp.Items {
		out = append(out, WorkloadInfo{
			Name:      d.Metadata.Name,
			Namespace: d.Metadata.Namespace,
			Ready:     d.Status.ReadyReplicas,
			Desired:   d.Spec.Replicas,
		})
	}
	return out, nil
}

type GatewayInfo struct {
	Name       string
	Namespace  string
	Address    string
	Programmed bool
}

func (c *Client) Gateways(ctx context.Context) ([]GatewayInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Status   struct {
				Addresses []struct {
					Value string `json:"value"`
				} `json:"addresses"`
				Conditions []condition `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/apis/gateway.networking.k8s.io/v1/gateways", &resp); err != nil {
		return nil, err
	}
	out := make([]GatewayInfo, 0, len(resp.Items))
	for _, g := range resp.Items {
		addr := ""
		if len(g.Status.Addresses) > 0 {
			addr = g.Status.Addresses[0].Value
		}
		out = append(out, GatewayInfo{
			Name:       g.Metadata.Name,
			Namespace:  g.Metadata.Namespace,
			Address:    addr,
			Programmed: condStatus(g.Status.Conditions, "Programmed") == "True",
		})
	}
	return out, nil
}

type RouteInfo struct {
	Name      string
	Namespace string
	Hostnames []string
	Gateway   string
}

func (c *Client) HTTPRoutes(ctx context.Context) ([]RouteInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Spec     struct {
				Hostnames  []string `json:"hostnames"`
				ParentRefs []struct {
					Name string `json:"name"`
				} `json:"parentRefs"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/apis/gateway.networking.k8s.io/v1/httproutes", &resp); err != nil {
		return nil, err
	}
	out := make([]RouteInfo, 0, len(resp.Items))
	for _, r := range resp.Items {
		gw := ""
		if len(r.Spec.ParentRefs) > 0 {
			gw = r.Spec.ParentRefs[0].Name
		}
		out = append(out, RouteInfo{
			Name:      r.Metadata.Name,
			Namespace: r.Metadata.Namespace,
			Hostnames: r.Spec.Hostnames,
			Gateway:   gw,
		})
	}
	return out, nil
}

type CertInfo struct {
	Name      string
	Namespace string
	DNSNames  []string
	NotAfter  *time.Time
	Ready     bool
}

func (c *Client) Certificates(ctx context.Context) ([]CertInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Spec     struct {
				DNSNames []string `json:"dnsNames"`
			} `json:"spec"`
			Status struct {
				NotAfter   *time.Time  `json:"notAfter"`
				Conditions []condition `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/apis/cert-manager.io/v1/certificates", &resp); err != nil {
		return nil, err
	}
	out := make([]CertInfo, 0, len(resp.Items))
	for _, ct := range resp.Items {
		out = append(out, CertInfo{
			Name:      ct.Metadata.Name,
			Namespace: ct.Metadata.Namespace,
			DNSNames:  ct.Spec.DNSNames,
			NotAfter:  ct.Status.NotAfter,
			Ready:     condStatus(ct.Status.Conditions, "Ready") == "True",
		})
	}
	return out, nil
}

type PGClusterInfo struct {
	Name      string
	Namespace string
	Instances int
	Ready     int
	Phase     string
}

func (c *Client) CNPGClusters(ctx context.Context) ([]PGClusterInfo, error) {
	var resp struct {
		Items []struct {
			Metadata meta `json:"metadata"`
			Spec     struct {
				Instances int `json:"instances"`
			} `json:"spec"`
			Status struct {
				Phase          string `json:"phase"`
				ReadyInstances int    `json:"readyInstances"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := c.getInto(ctx, "/apis/postgresql.cnpg.io/v1/clusters", &resp); err != nil {
		return nil, err
	}
	out := make([]PGClusterInfo, 0, len(resp.Items))
	for _, p := range resp.Items {
		out = append(out, PGClusterInfo{
			Name:      p.Metadata.Name,
			Namespace: p.Metadata.Namespace,
			Instances: p.Spec.Instances,
			Ready:     p.Status.ReadyInstances,
			Phase:     p.Status.Phase,
		})
	}
	return out, nil
}
