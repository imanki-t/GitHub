# Unified GitHub & Render MCP Gateway

This repository contains a lightweight, single-port Model Context Protocol (MCP) server that merges local GitHub utility tools with a curated, token-efficient proxy to official Render developer actions. 

By filtering the Render integration to only five high-value tools and dynamically optimizing their JSON schema descriptions, this gateway reduces startup and conversational context consumption by up to 80% compared to a standard, full-service registration.

---

## Features

### 1. GitHub Integration (14 Tools)
*   **Repository Access:** `get_viewer`, `list_repos`, `search_repos`, `list_branches`
*   **File Manipulation:** `get_tree`, `get_contents`, `put_contents`, `patch_contents`, `delete_contents`, `grep_file`
*   **Git Control:** `create_ref`, `delete_ref`, `search_code`, `create_pull`

### 2. Streamlined Render Integration (5 Tools)
To prevent your chat limits from draining due to schema overhead, only these five foundational Render tools are registered:
*   `list_services` — Lists all web services, background workers, and databases.
*   `get_service` — Inspects the direct configuration and runtime status of a service.
*   `list_deploys` — Retrieves deployment success/failure history.
*   `get_deploy` — Gets exact details of a specific build phase.
*   `list_logs` — Pulls live application server logs for debugging.

---

## Configuration

Duplicate `.env.example` as `.env` and fill out your credentials:

```bash
cp .env.example .env
