#!/usr/bin/env bun
/**
 * Agent Context Viewer — entry point.
 * Shows how AI coding agents assemble context: system prompts, AGENTS.md files,
 * per-prompt before/after context, compaction, and full transcripts.
 */
import React from "react";
import { render } from "ink";
import { App } from "./app.tsx";

render(<App />);
