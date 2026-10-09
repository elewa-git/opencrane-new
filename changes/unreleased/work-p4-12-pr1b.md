- Add current memory tables, searchable text and an offline operator rebuild from saved events.
  Replay reads existing revision keys before database transactions and keeps destroyed content unavailable.
- Refuse repeated memory dependencies and mismatched revision key references before saving events.
  Keep newer memory rows and stable change history when keys are deleted.
- Check every required key before replacing memory tables, and log preparation failures
  inside the handler trace. Read memory ids and search matches within one silo and scope.
