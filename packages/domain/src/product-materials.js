export const maxProductImages = 12;
const text = (v, max = 240) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const url = v => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
export function imageMetadata(image) {
  return {
    alt: text(image.alt), variantId: text(image.variantId, 100), variantName: text(image.variantName, 160),
    identityStatus: ['selected_variant','other_variant','known_variant','needs_variant_check'].includes(image.identityStatus) ? image.identityStatus : 'needs_variant_check',
    role: ['product_primary','product_view'].includes(image.role) ? image.role : 'product_view',
    sourceType: ['product_variant','schema_product_image','product_data','product_gallery'].includes(image.sourceType) ? image.sourceType : 'product_page'
  };
}
export function importMedia(result) {
  return {
    videos: (Array.isArray(result.videos) ? result.videos : []).slice(0, 6).filter(v => url(v?.url)).map(v => ({ url: url(v.url), role: 'product_video', status: 'link_only', visualVerification: 'not_performed' })),
    variants: (Array.isArray(result.variants) ? result.variants : []).slice(0, 80).filter(v => text(v?.id, 100)).map(v => ({ id: text(v.id, 100), name: text(v.name, 160), sku: text(v.sku, 160), selected: v.selected === true })),
    selectedVariantId: text(result.selectedVariantId, 100)
  };
}
