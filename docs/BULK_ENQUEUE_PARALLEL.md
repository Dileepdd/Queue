## Parallel vs Sequential Job Status Updates

### Bulk Enqueue API

When using the bulk enqueue API, job status updates are now performed in parallel if any job in the batch has `executionMode: "parallel"`. Otherwise, updates are performed sequentially for strict ordering.

- Parallel mode: Faster, suitable for independent jobs.
- Sequential mode: Used if all jobs require ordered status updates.

#### Example

```json
{
  "job": { ... },
  "executionMode": "parallel"
}
```

### Postman Collection

To test parallel/sequential behavior, set the `executionMode` variable in your Postman requests:

- `parallel` for concurrent status updates
- `sequential` for ordered status updates

### API Reference

- `POST /jobs/bulk` supports `executionMode` per job.
- Status updates are optimized for client configuration.

---

For more details, see the updated API docs and request flow documentation.
