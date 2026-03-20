import express from 'express';
import { requireAdminToken } from '../admin/middleware.js';
import { requireClientHmacAuth } from '../auth/middleware.js';
import { signJwt } from '../auth/jwt.js';
import { getAuthContext } from '../auth/context.js';

const router = express.Router();

// Admin login: expects X-Admin-Token header
router.post('/admin/login', requireAdminToken(), (req, res) => {
  // If middleware passes, admin token is valid
  const jwt = signJwt({ userType: 'admin' });
  res.status(200).json({ token: jwt, userType: 'admin' });
});

// Client login: expects HMAC or Bearer auth headers
router.post('/client/login', requireClientHmacAuth(), (req, res) => {
  const ctx = getAuthContext(res);
  if (!ctx) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const jwt = signJwt({ userType: 'client', tenantId: ctx.tenantId, keyId: ctx.keyId, clientName: ctx.clientName });
  res.status(200).json({ token: jwt, userType: 'client', tenantId: ctx.tenantId, clientName: ctx.clientName });
});

export default router;
