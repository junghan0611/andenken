.mode list
.separator ' | '
select 'schema', version from durable_schema;
select 'conv', id, owner_conversation_id, owner_task_id, record from conversations;
select 'E', e.id, e.conversation_id, e.commit_seq, e.head, json_extract(record,'$.kind'), json_extract(record,'$.byTaskId'),
  json_extract(record,'$.model[0].role'), json_extract(record,'$.model[0].timestamp'), json_extract(record,'$.model[0].stopReason'),
  substr(coalesce(json_extract(record,'$.model[0].content'),''),1,80),
  (select s.request_id from submissions s where json_extract(s.record,'$.entry')=e.id),
  json_extract(record,'$.data')
from entries e order by e.id;
