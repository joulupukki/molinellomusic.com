import data from './for-sale.json';

export type ListingStatus = 'available' | 'pending' | 'sold';

export interface ListingPhoto {
  src: string;
  thumb?: string;
  alt: string;
}

export interface Listing {
  id: string;
  title: string;
  published: boolean;
  status: ListingStatus;
  dateListed: string;
  condition: string;
  photos: ListingPhoto[];
  note?: string;
  description: string;
  price?: string;
  specs?: [string, string][];
}

const all = data.items as Listing[];

/** Listings that should render on /for-sale: published, and not sold unless showSold is on. */
export const listings: Listing[] = all.filter(
  (item) => item.published && (item.status !== 'sold' || data.showSold),
);

/** A live (published, not sold) listing by id, or undefined. Used to link gallery entries to their listing. */
export function liveListing(id: string | undefined): Listing | undefined {
  if (!id) return undefined;
  return all.find((item) => item.id === id && item.published && item.status !== 'sold');
}
