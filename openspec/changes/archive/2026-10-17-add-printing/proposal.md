# Proposal

## Why

Stage P7: printing from the portal must be a real function — allowed users only, size and type checks, safe handling of bad documents, no execution of uploaded content, and a logged result — on the existing Windows PC without CUPS or a virtual machine.

## What Changes

- A minimal IPP client and a print queue in the portal: PDF/JPEG recognised by content, Validate-Job before anything is printed, explicit confirmation, Print-Job sent chunked (the HP M283 aborts jobs whose document has a Content-Length), job tracking, cancel, expiry of unconfirmed jobs, audit without file names.
- Printer state over IPP in the background (never blocks a page); toner levels only when the printer reports them.
- The «Печать» page; the `print` right.

## Capabilities

### New Capabilities
- `printing`.

## Impact

`server/src/print/{ipp,queue,routes}.ts`, config `PRINTER_IPP_URL`, `PRINT_MAX_MB`, `web/src/pages/Print.tsx`; ADR-0009, runbook printing.
