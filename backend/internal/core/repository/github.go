package repository

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/guz-studio/cac/backend/internal/core/domain"
	"github.com/zalando/go-keyring"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/nacl/box"
)

const githubAPI = "https://api.github.com"

func githubTokenAccount(serverID string) string {
	return "github-token:" + serverID
}

func StoreGitHubToken(serverID, token string) error {
	return keyring.Set(keychainService, githubTokenAccount(serverID), token)
}

func GetGitHubToken(serverID string) (string, error) {
	token, err := keyring.Get(keychainService, githubTokenAccount(serverID))
	if err != nil {
		return "", err
	}
	return token, nil
}

func DeleteGitHubToken(serverID string) error {
	return keyring.Delete(keychainService, githubTokenAccount(serverID))
}

func IsGitHubTokenConfigured(serverID string) bool {
	_, err := GetGitHubToken(serverID)
	return err == nil
}

// ─── GitHub API helpers ────────────────────────────────────────────────────────

func githubRequest(method, url, token string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return http.DefaultClient.Do(req)
}

func ListGitHubSecrets(serverID, owner, repo string) (*domain.GitHubSecretsResponse, error) {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return nil, fmt.Errorf("no github token configured")
	}

	url := fmt.Sprintf("%s/repos/%s/%s/actions/secrets", githubAPI, owner, repo)
	resp, err := githubRequest("GET", url, token, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}

	var result domain.GitHubSecretsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func ListGitHubVariables(serverID, owner, repo string) (*domain.GitHubVariablesResponse, error) {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return nil, fmt.Errorf("no github token configured")
	}

	url := fmt.Sprintf("%s/repos/%s/%s/actions/variables", githubAPI, owner, repo)
	resp, err := githubRequest("GET", url, token, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}

	var result domain.GitHubVariablesResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

// SetGitHubSecret encrypts the value with the repo's public key and upserts the secret.
func SetGitHubSecret(serverID, owner, repo, name, value string) error {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return fmt.Errorf("no github token configured")
	}

	// 1. Get repo public key
	keyURL := fmt.Sprintf("%s/repos/%s/%s/actions/secrets/public-key", githubAPI, owner, repo)
	resp, err := githubRequest("GET", keyURL, token, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}

	var pubKeyResp struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&pubKeyResp); err != nil {
		return err
	}

	// 2. Encrypt value using crypto_box_seal (NaCl sealed box)
	encrypted, err := sealBox(pubKeyResp.Key, value)
	if err != nil {
		return fmt.Errorf("encrypt secret: %w", err)
	}

	// 3. PUT the encrypted secret
	secretURL := fmt.Sprintf("%s/repos/%s/%s/actions/secrets/%s", githubAPI, owner, repo, name)
	payload, _ := json.Marshal(map[string]string{
		"encrypted_value": encrypted,
		"key_id":          pubKeyResp.KeyID,
	})
	putResp, err := githubRequest("PUT", secretURL, token, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer putResp.Body.Close()

	if putResp.StatusCode != http.StatusCreated && putResp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(putResp.Body)
		return fmt.Errorf("github api error %d: %s", putResp.StatusCode, body)
	}
	return nil
}

// SetGitHubVariable creates or updates a repo Actions variable.
func SetGitHubVariable(serverID, owner, repo, name, value string, exists bool) error {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return fmt.Errorf("no github token configured")
	}

	payload, _ := json.Marshal(map[string]string{"name": name, "value": value})

	var (
		method string
		url    string
	)
	if exists {
		method = "PATCH"
		url = fmt.Sprintf("%s/repos/%s/%s/actions/variables/%s", githubAPI, owner, repo, name)
	} else {
		method = "POST"
		url = fmt.Sprintf("%s/repos/%s/%s/actions/variables", githubAPI, owner, repo)
	}

	resp, err := githubRequest(method, url, token, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}
	return nil
}

// DeleteGitHubSecret deletes a repo Actions secret.
func DeleteGitHubSecret(serverID, owner, repo, name string) error {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return fmt.Errorf("no github token configured")
	}

	url := fmt.Sprintf("%s/repos/%s/%s/actions/secrets/%s", githubAPI, owner, repo, name)
	resp, err := githubRequest("DELETE", url, token, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}
	return nil
}

// DeleteGitHubVariable deletes a repo Actions variable.
func DeleteGitHubVariable(serverID, owner, repo, name string) error {
	token, err := GetGitHubToken(serverID)
	if err != nil {
		return fmt.Errorf("no github token configured")
	}

	url := fmt.Sprintf("%s/repos/%s/%s/actions/variables/%s", githubAPI, owner, repo, name)
	resp, err := githubRequest("DELETE", url, token, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("github api error %d: %s", resp.StatusCode, body)
	}
	return nil
}

// sealBox implements crypto_box_seal (NaCl anonymous sealed box) as required by GitHub secrets API.
// Output is base64-encoded: ephemeral_public_key || encrypted_message
func sealBox(recipientPubB64, message string) (string, error) {
	recipientKeyBytes, err := base64.StdEncoding.DecodeString(recipientPubB64)
	if err != nil {
		return "", fmt.Errorf("decode public key: %w", err)
	}
	if len(recipientKeyBytes) != 32 {
		return "", fmt.Errorf("public key must be 32 bytes, got %d", len(recipientKeyBytes))
	}
	var recipientKey [32]byte
	copy(recipientKey[:], recipientKeyBytes)

	ephPub, ephPriv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("generate keypair: %w", err)
	}

	// nonce = BLAKE2b-192(ephPub || recipientKey) — matches libsodium crypto_box_seal
	h, err := blake2b.New(24, nil)
	if err != nil {
		return "", fmt.Errorf("blake2b init: %w", err)
	}
	h.Write(ephPub[:])
	h.Write(recipientKey[:])
	var nonce [24]byte
	copy(nonce[:], h.Sum(nil))

	encrypted := box.Seal(ephPub[:], []byte(message), &nonce, &recipientKey, ephPriv)
	return base64.StdEncoding.EncodeToString(encrypted), nil
}
