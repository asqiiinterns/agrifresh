// Categories come from Appro+'s shared list (20261116); "Tous" is the "no filter" choice of the order screen.
export type Category = string;

export type Product = {
  id: string;
  name: string;
  description: string;
  category: string;
  categorySort?: number;
  // Category ids, for the supplier's offers on a category (buyer catalogue).
  categoryId?: string | null;
  categoryParentId?: string | null;
  price: number;
  // VAT rate in %, prices being excl. VAT.
  vatRate?: number;
  unit: string;
  image: string;
  badge?: string;
  available: boolean;
  isNew?: boolean;
  stock?: number;
  origin?: { producer?: string; region?: string; label?: string; note?: string } | null;
  // Buyer cart across several suppliers: the supplier relation (client record) the product comes from.
  supplierId?: string;
};