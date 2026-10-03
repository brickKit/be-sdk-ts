// Sends PostgreSQL's CancelRequest for a backend (the protocol's out-of-band cancel, what pg_cancel_backend does
// from SQL): used when the unit of work is aborted while a statement runs. A fresh socket per cancel, never a
// pooled connection.
import net from "node:net";

const CANCEL_CODE = 80877102;

export interface CancelTarget {
  host: string;
  port: number;
  processID: number;
  secretKey: number;
}

/** The cancel target of a connected pg client, or undefined when the driver did not expose it. */
export function cancelTargetOf(client: unknown): CancelTarget | undefined {
  const c = client as Partial<CancelTarget> | null;
  if (!c || typeof c.processID !== "number" || typeof c.secretKey !== "number") return undefined;
  return { host: String(c.host ?? "localhost"), port: Number(c.port ?? 5432), processID: c.processID, secretKey: c.secretKey };
}

export function sendCancel(t: CancelTarget): Promise<void> {
  return new Promise((resolve) => {
    const socket = t.host.startsWith("/") ? net.connect({ path: `${t.host}/.s.PGSQL.${t.port}` }) : net.connect(t.port, t.host);
    const msg = Buffer.alloc(16);
    msg.writeInt32BE(16, 0);
    msg.writeInt32BE(CANCEL_CODE, 4);
    msg.writeInt32BE(t.processID, 8);
    msg.writeInt32BE(t.secretKey, 12);
    socket.setTimeout(2_000, () => socket.destroy());
    socket.once("connect", () => socket.end(msg));
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}
