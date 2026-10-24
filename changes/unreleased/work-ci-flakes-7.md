- Keep the connection cleanup retry test reliable under load by waiting for its database
  lock before each delete attempt. Continue checking all retries and the saved failed job.
