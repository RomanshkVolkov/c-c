import type { RequestTreeNode } from "@/store/requests.store";

export type CollectionPermission = "read" | "write";

export interface CollectionMeta {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  permission: CollectionPermission;
  isOwner: boolean;
  updatedAt: string;
}

export interface CollectionDetail {
  collection: CollectionMeta;
  nodes: RequestTreeNode[];
}

export interface ShareInfo {
  userId: string;
  username: string;
  permission: CollectionPermission;
}

export interface UserSummary {
  id: string;
  username: string;
}
