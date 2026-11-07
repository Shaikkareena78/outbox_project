import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, config.SESSION_SECRET, { expiresIn: "7d" });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.cookies?.session as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, config.SESSION_SECRET);
    if (typeof payload === "string" || typeof payload.sub !== "string") throw new Error("Invalid session");
    req.userId = payload.sub;
    next();
  } catch {
    res.clearCookie("session");
    res.status(401).json({ error: "Session expired; please sign in again" });
  }
}
