import { Injectable, Module } from '@nestjs/common';
import type { Server } from 'socket.io';

/** Centralized presence + per-member event emitter. Lives in its own leaf module so
 *  both NotificationsService (read) and the chat/call gateways (write) can depend on it
 *  without a circular module graph.
 *
 *  Holds two maps:
 *    - `online`: memberId → Set<socketId>. Read by isOnline().
 *    - `screen`: memberId → { screen, ts }. Read by isActiveOn() (60s freshness).
 *
 *  Gateways register their `Server` here on init so dispatch() can emit to mem:<id> rooms
 *  without importing the gateway class. */
@Injectable()
export class PresenceService {
  private chatServer: Server | null = null;
  private online = new Map<string, Set<string>>();
  private screen = new Map<string, { screen: string; ts: number }>();
  private static readonly SCREEN_TTL_MS = 60_000;

  registerChatServer(server: Server) { this.chatServer = server; }

  addSocket(memberId: string, socketId: string) {
    if (!this.online.has(memberId)) this.online.set(memberId, new Set());
    this.online.get(memberId)!.add(socketId);
  }

  removeSocket(memberId: string, socketId: string) {
    const set = this.online.get(memberId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) {
      this.online.delete(memberId);
      this.screen.delete(memberId);
    }
  }

  isOnline(memberId: string) { return (this.online.get(memberId)?.size ?? 0) > 0; }

  setScreen(memberId: string, screen: string) {
    if (!screen) { this.screen.delete(memberId); return; }
    this.screen.set(memberId, { screen, ts: Date.now() });
  }

  /** Returns true iff member is online AND their currentScreen exactly equals `screen`
   *  AND the screen update is fresh (<60s old). */
  isActiveOn(memberId: string, screen: string): boolean {
    if (!this.isOnline(memberId)) return false;
    const s = this.screen.get(memberId);
    if (!s) return false;
    if (Date.now() - s.ts > PresenceService.SCREEN_TTL_MS) return false;
    return s.screen === screen;
  }

  emitToMember(memberId: string, event: string, payload: any) {
    if (!this.chatServer) return;
    this.chatServer.to(`mem:${memberId}`).emit(event, payload);
  }
}

@Module({ providers: [PresenceService], exports: [PresenceService] })
export class PresenceModule {}
