begin;
-- service_role cannot SELECT auth.users. These narrow RPCs need the function
-- owner's access to check verification/bans. Both retain an empty search_path,
-- fully qualified relations, and EXECUTE grants exclusively to service_role.
alter function public.create_agent_api_key(uuid,text,text,text,text[],timestamptz) security definer;
alter function public.authorize_agent_api_key(text,text[]) security definer;
commit;
