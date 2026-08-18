export type OrgRole = "admin" | "member" | "viewer";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: OrgRole; // caller's role in this org
  /** How many people are in it. Counted server-side; see OrganizationResponse. */
  memberCount: number;
  createdAt: string;
  domain?: string;
  defaultInviteRole?: OrgRole;
  clientsSeeOnlyTheirSpace: boolean;
  guestsCanUseDevTools: boolean;
}

export interface OrgMember {
  userId: string;
  username: string;
  email?: string;
  role: OrgRole;
  /** Absent means the account has done nothing since this began being kept. */
  lastSeenAt?: string | null;
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
  // Sólo en la vista de administración: ahí sí llegan las caducadas, y sin la
  // fecha no habría forma de distinguirlas de las vigentes.
  expiresAt?: string;
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
