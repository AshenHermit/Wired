# Room State Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Add a room settings section with buttons to clear current user / all users / dynamic objects data from server state.json, with confirmation modals.

**Architecture:** Backend HTTP endpoint mutates state.json (and forwards to runtime if running). Frontend section in RoomAccessSettingsDialog with confirmation AlertDialogs.

**Tech Stack:** NestJS, React/Next.js, shadcn/ui.

**Spec:** docs/superpowers/specs/2026-11-08-room-state-cleanup-design.md

## Tasks (high-level)
1. Backend: create `StateCleanupController` + service editing state.json atomically; owner checks.
2. Frontend: add API client method `cleanupRoomState`.
3. Frontend: add section + buttons + confirmation modals in RoomAccessSettingsDialog.
4. Tests: backend unit + frontend component.
5. i18n strings.

Plan details to be expanded by implementer.
