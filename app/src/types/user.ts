export interface AdminUser {
  id: string;
  username: string;
  email: string;
  name: string;
  isSuperadmin: boolean;
  createdAt: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  // Obligatorios al crear, igual que en `CreateUserRequest` del backend.
  email: string;
  name: string;
  isSuperadmin?: boolean;
}

export interface UpdateUserPayload {
  password?: string;
  email?: string;
  name?: string;
  isSuperadmin?: boolean;
}
