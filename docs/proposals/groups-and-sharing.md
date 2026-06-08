# Proposal — Groups & multi-user sharing

**Status:** Draft / not implemented. Single-user is the only supported model today.

This document sketches how to evolve the data model and API to support multiple users sharing servers and collections through **groups**. It is intentionally not committed to a timeline — the goal is to think through the shape before any DB migration so today's decisions don't paint us into a corner.

## Motivation

- Today the backend has a `users` table but no concept of resource ownership beyond `CollectionShare`. Servers are effectively global (any authenticated user can list/manage every registered server).
- Collections already have a share model (`CollectionShare` rows linking a collection to a user), but it's per-user — there's no notion of "everyone on the platform team can edit these collections."
- As the org adopts the tool, we want predictable, audit-friendly access: "members of the `infra` group can manage `prod-*` servers; members of `apps` can only read."

## Proposed data model

Add a `groups` table and a `group_memberships` join table. Resources point to a single owning group (the principal) rather than a single owning user.

```
groups
  id            uuid pk
  name          varchar(100)        // unique
  description   text                // optional
  created_at, updated_at

group_memberships
  group_id      uuid fk → groups(id) on delete cascade
  user_id       uuid fk → users(id)  on delete cascade
  role          varchar(20)         // 'admin' | 'member' | 'viewer'
  primary key (group_id, user_id)

servers
  ...existing columns...
  group_id      uuid fk → groups(id)  // NEW: replaces implicit global ownership

collections
  ...existing columns...
  owner_user_id uuid                  // keep — personal collections still exist
  group_id      uuid fk → groups(id)  // NEW: optional, when set the collection is a group resource

collection_shares
  ...existing...                       // DEPRECATED for group-scoped collections,
                                       // retained for personal-collection ad-hoc shares
```

### Why a separate join table instead of a single `group_id` on `users`?

Because users belong to multiple groups in real teams, and per-group role makes audit/access decisions concrete. A `users.group_id` would force one-membership-per-user, which we'd outgrow on day one.

### Why keep `owner_user_id` on collections?

Personal scratchpads exist. Users want a place to keep request collections that aren't shared — making everything group-scoped removes that affordance. A collection has **either** a `group_id` **or** an `owner_user_id`, exclusively. `CollectionShare` stays alive only for the personal-collection use case (one user grants another ad-hoc access).

## Role semantics

| Role | Servers | Collections (group) |
|---|---|---|
| `admin` | full CRUD + manage group membership | full CRUD |
| `member` | read + write metadata, no delete | full CRUD |
| `viewer` | read-only | read-only |

Open question: do we want role overrides per resource (e.g. a viewer who's an admin on one specific server)? Probably not in v1 — keep the model boring.

## API impact

New endpoints:

```
POST   /api/v1/groups/                          create group (becomes admin)
GET    /api/v1/groups/                          list groups the caller belongs to
GET    /api/v1/groups/{id}                      group detail + members
PATCH  /api/v1/groups/{id}                      rename/describe
DELETE /api/v1/groups/{id}                      delete (admin only)
POST   /api/v1/groups/{id}/members              add member by user_id+role (admin only)
PATCH  /api/v1/groups/{id}/members/{userId}     change role (admin only)
DELETE /api/v1/groups/{id}/members/{userId}     remove (admin or self)
```

Existing endpoints gain access checks:

- `GET /api/v1/servers/` returns only servers in groups the caller belongs to.
- `POST /api/v1/servers/` requires `group_id` in the body; caller must be `admin`/`member` of that group.
- `GET /api/v1/collections/` unions: personal collections owned by caller + group collections from caller's groups + ad-hoc shares (legacy).

## Migration

1. Create `groups` + `group_memberships` tables.
2. Create a default group (e.g. `Personal`) per existing user.
3. Backfill `servers.group_id` → first user's personal group (single-tenant assumption today). If multi-user data exists by the time this runs, we punt: write a `MIGRATE-ME` flag and require manual reassignment.
4. Add NOT NULL constraint on `servers.group_id` once backfill is done.

The `CollectionShare` path stays untouched for personal collections; the new group-scoped path is additive.

## Auth / token impact

JWT claims should include `group_memberships: [{groupId, role}]` so middleware can short-circuit lookups. Refresh tokens that pre-date a membership change need to be invalidated, or the access token needs a short TTL (it already does — 60m). Lean on the existing refresh flow.

## UI sketch (desktop app)

- Sidebar gains a **Groups** entry → manage memberships.
- `AddServerDialog` gains a `Group` selector (defaults to the user's personal group).
- `Dashboard` filters by group via a top-level dropdown ("All", or one group at a time).
- Collections list visually segments **Personal**, **Group: infra**, **Group: apps**, **Shared with me**.

## Non-goals (v1)

- SSO / SAML / external identity providers.
- Cross-org sharing.
- Per-resource permission overrides.
- Audit log surface (the data is there — DB rows — but no UI yet).

## Tradeoffs to revisit

- Storing role on the membership row instead of a separate `roles` table — fine while we have 3 roles, painful if it grows. Lean on `varchar` enum constraints for now.
- Personal vs. group collections being the same table — keeps queries simple, adds a CHECK constraint (`owner_user_id IS NULL OR group_id IS NULL`). Splitting into two tables would be cleaner but doubles the API surface.
