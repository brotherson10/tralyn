/** Human label for a product: brand + model (the schema has no separate "name"). */
export function productLabel(product: { brand: string | null; model: string | null }): string {
  return [product.brand, product.model].filter((part) => part && part.trim() !== "").join(" ") || "—";
}
