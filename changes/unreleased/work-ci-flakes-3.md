- Memory correction race tests now wait for the competing write before checking the stale revision. Decision cost tests finish cold grant loading before measuring admission, without retrying admissions or changing production deadlines.
- Correction tests also require 409 while another correction holds the write slot. Decision cost tests wait for applied grant receipts and issue fresh turn tokens after preparation, keeping the two-second admission limit.
- The long-grant timing tests finish their first small access reads before HTTP warm-up.
  They keep the two-second limit and check delayed assistant lookups with permissions already applied.
