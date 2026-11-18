-- Запусти ПОСЛЕ того, как создала пользователя Лены (Authentication → Users → Add user)
insert into public.masters (uid)
select id from auth.users where email = 'elenadelsol@gmail.com'
on conflict do nothing;

-- проверка: должна появиться одна строка
select u.email from public.masters m join auth.users u on u.id = m.uid;
