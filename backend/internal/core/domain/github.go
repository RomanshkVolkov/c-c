package domain

// GitHub PAT management
type SetGitHubTokenRequest struct {
	Token string `json:"token" validate:"required"`
}

type GitHubTokenStatus struct {
	Configured bool `json:"configured"`
}

// GitHub Secrets
type GitHubSecret struct {
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type GitHubSecretsResponse struct {
	TotalCount int            `json:"total_count"`
	Secrets    []GitHubSecret `json:"secrets"`
}

type SetSecretRequest struct {
	Value string `json:"value" validate:"required"`
}

// GitHub Variables
type GitHubVariable struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type GitHubVariablesResponse struct {
	TotalCount int              `json:"total_count"`
	Variables  []GitHubVariable `json:"variables"`
}

type SetVariableRequest struct {
	Value  string `json:"value"  validate:"required"`
	Exists bool   `json:"exists"`
}
