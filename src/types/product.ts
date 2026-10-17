export type Category = "Tous" | "Jus frais" | "Fruits" | "Légumes" | "Épicerie";

export type Product = {
  id: string;
  name: string;
  description: string;
  category: Exclude<Category, "Tous">;
  price: number;
  unit: string;
  image: string;
  badge?: string;
  available: boolean;
  isNew?: boolean;
  origin?: { producer?: string; region?: string; label?: string; note?: string } | null;
};