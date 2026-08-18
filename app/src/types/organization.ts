export type OrgRole = "admin" | "member" | "viewer";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole; // caller's role in this org
  /** How many people are in it. Counted server-side; see OrganizationResponse. */
  memberCount: number;
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

export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked";

export interface Invitation {
  id: string;
  orgId: string;
  orgName: string;
  role: OrgRole;
  status: InvitationStatus;
  invitedBy: string; // inviter username
  invitedUser?: string; // invitee username (org-side listing only)
  createdAt: string;
}

export interface CreateInvitationPayload {
  userId: string;
  role: OrgRole;
}

/** roleAtLeast mirrors the backend rank: admin > member > viewer. */
const RANK: Record<OrgRole, number> = { admin: 3, member: 2, viewer: 1 };
export function roleAtLeast(have: OrgRole, min: OrgRole): boolean {
  return RANK[have] >= RANK[min];
}
