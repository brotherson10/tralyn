-- =============================================================================
-- Products without a known model
--
-- Some products (e.g. EV chargers known only by brand) have no
-- known model. Missing information is represented by NULL, never by
-- placeholder text. Every product must still be identifiable: brand OR model
-- must be filled in, and neither may be an empty/whitespace string.
--
-- Forward-only. Only relaxes NOT NULL on products.model and adds checks that
-- every existing row already satisfies (all current rows have a model).
-- =============================================================================

alter table public.products
  alter column model drop not null;

-- Same name as before, now allowing NULL (but still no blank text).
alter table public.products
  drop constraint products_model_not_blank;

alter table public.products
  add constraint products_model_not_blank
  check (model is null or btrim(model) <> '');

-- Brand: NULL or real text (the application already normalizes blanks to NULL).
alter table public.products
  add constraint products_brand_not_blank
  check (brand is null or btrim(brand) <> '');

-- With both checks above, "not null" means "really filled in".
alter table public.products
  add constraint products_brand_or_model_present
  check (brand is not null or model is not null);
