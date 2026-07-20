UPDATE agent_runs
SET progress = 100,
    stage_message = CASE status WHEN 'ready' THEN 'Ready' WHEN 'failed' THEN 'Failed' ELSE stage_message END
WHERE status IN ('ready', 'failed') AND progress < 100;
