export type OrgRole = "admin" | "member" | "viewer";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole; // caller's role in this org
}

export interface OrgMember {
  userId: string;
  username: string;
  role: OrgRole;
}

export interface CreateOrganizationPayload {
  name: string;
  slug?: string;
}

export interface AddMemberPayload {
  userId: string;
  role: OrgRole;
}

/** roleAtLeast mirrors the backend rank: admin > member > viewer. */
const RANK: Record<OrgRole, number> = { admin: 3, member: 2, viewer: 1 };
export function roleAtLeast(have: OrgRole, min: OrgRole): boolean {
  return RANK[have] >= RANK[min];
}
