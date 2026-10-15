-- Deny by default. Every later grant names exact columns or an exact function signature.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on tables    from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke all on functions from public, anon, authenticated;

-- service_role gets no table or sequence access: every write is an RPC (security definer functions run as postgres).
alter default privileges for role postgres in schema public  revoke all on tables    from service_role;
alter default privileges for role postgres in schema public  revoke all on sequences from service_role;
alter default privileges for role postgres in schema private revoke all on tables    from service_role;
alter default privileges for role postgres in schema private revoke all on sequences from service_role;

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
