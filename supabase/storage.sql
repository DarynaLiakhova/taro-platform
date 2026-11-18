-- Путь Таролога · хранилище для видео в переписке
-- Вставь целиком в SQL Editor → Run. Один раз. Повторный запуск ничего не ломает.

-- закрытая «папка» media, файлы до 50 МБ, только видео
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['video/mp4','video/quicktime','video/webm','video/3gpp','video/x-matroska'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- у каждой ученицы своя папка (её id). Ученица видит и кладёт только своё, Лена — всё
drop policy if exists media_select on storage.objects;
create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_master()));

drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_master()));

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_master()));

-- ===== голос и фото из переписки (добавлено 12.11) =====
-- открытая «папка» chat: файлы читаются по ссылке со случайным длинным именем (как в Telegram),
-- загружать может только вошедший человек и только в свою папку (Лена — в любую)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat', 'chat', true, 52428800, array['image/jpeg','image/png','image/webp','image/gif','image/heic','audio/webm','audio/ogg','audio/mp4','audio/x-m4a','audio/aac','audio/mpeg','audio/wav','application/octet-stream'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists chat_insert on storage.objects;
create policy chat_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'chat' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_master()));

drop policy if exists chat_delete on storage.objects;
create policy chat_delete on storage.objects for delete to authenticated
  using (bucket_id = 'chat' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_master()));
