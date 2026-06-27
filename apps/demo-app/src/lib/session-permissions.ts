export type SessionPermission = {
  sessionId: string;
  capability: string;
};

export function hasSessionPermission(_permission: SessionPermission): boolean {
  return false;
}
