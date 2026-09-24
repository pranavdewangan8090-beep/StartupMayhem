import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const EXPIRES_IN = '12h'; // the whole event runs in a single day

export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret); // throws on invalid/expired
}
