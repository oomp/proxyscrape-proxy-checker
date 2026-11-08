package updater

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// releasesBaseURL is the base R2 URL. The channel path segment is appended at
// runtime so each build only fetches its own channel's entries.
// Override with UPDATES_URL env var for local testing (e.g. a mock server).
const releasesBaseURL = "https://software.cdn.proxyscrape.com"

// Release holds the fields we expose from a single changelog entry.
type Release struct {
	TagName     string `json:"tagName"`
	PublishedAt string `json:"publishedAt"`
	HtmlURL     string `json:"htmlUrl"`
	Body        string `json:"body"`
}

// VersionInfo holds version comparison results returned to the frontend.
type VersionInfo struct {
	Current        string    `json:"current"`
	Latest         string    `json:"latest"`
	HasUpdate      bool      `json:"hasUpdate"`
	CanaryReleases []Release `json:"canaryReleases"`
	Releases       []Release `json:"releases"`
}

// r2Release matches the JSON schema produced by scripts/build-releases-json.mjs.
type r2Release struct {
	Version string `json:"version"`
	Date    string `json:"date"`
	Channel string `json:"channel"`
	Notes   string `json:"notes"`
}

// Check returns the local version without contacting the official update service.
func Check(_ context.Context, currentVersion string) VersionInfo {
	return VersionInfo{
		Current:        currentVersion,
		Latest:         currentVersion,
		HasUpdate:      false,
		CanaryReleases: []Release{},
		Releases:       []Release{},
	}
}

// isNewerVersion returns true only when candidate is strictly greater than base.
// Both strings may carry a "v" prefix and a pre-release suffix (e.g. "-canary").
func isNewerVersion(candidate, base string) bool {
	parse := func(v string) [3]int {
		v = strings.TrimPrefix(v, "v")
		v = strings.SplitN(v, "-", 2)[0] // strip -canary / -beta / etc.
		parts := strings.Split(v, ".")
		var out [3]int
		for i := 0; i < 3 && i < len(parts); i++ {
			out[i], _ = strconv.Atoi(parts[i])
		}
		return out
	}
	c := parse(candidate)
	b := parse(base)
	for i := 0; i < 3; i++ {
		if c[i] > b[i] {
			return true
		}
		if c[i] < b[i] {
			return false
		}
	}
	return false
}

// String returns a human-readable description of the version check result.
func (v VersionInfo) String() string {
	if v.HasUpdate {
		return fmt.Sprintf("Update available: %s → %s", v.Current, v.Latest)
	}
	return fmt.Sprintf("Up to date: %s", v.Current)
}
