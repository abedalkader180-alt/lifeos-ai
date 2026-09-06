// Vercel Node.js serverless entrypoint.
// Keep this SYNCHRONOUS and simple. Vercel calls it with (req, res).
// We load config, create schema (fire-and-forget best effort), then serve Express.

require('../src/config');
const path = require('path');
const express = require('express');
const db = require('../src/db');

// Best-effort schema creation (tables for Postgres). If it fails, error is logged.
db.initSchema().catch((e) => console.error('[lifeos] initSchema failed:', e));

const { app } = require('../src/app');

// Serve static files from /public, then fall back to Express routes.
app.use(express.static(path.join(__dirname, '..', 'public')));

// If no route matched (non-API path), serve index.html / app.html / admin.html.
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'app.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

module.exports = app;
