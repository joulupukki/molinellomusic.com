// Site-wide constants and navigation. The header (desktop and mobile) and the
// footer both render from `nav`, so a link only has to be changed here.

export const contactEmail = 'info@molinellomusic.com';
export const contactPhone = '801-893-1171';

export const chesterBuyUrl = 'https://buy.stripe.com/aFabJ12Ud2pbgar6qM8og0p';

export const album = {
  band: 'Basin & Grange',
  title: 'Walk You Down the Road',
  released: 'June 5, 2024',
  releasedISO: '2024-06-05',
  cover: '/images/home/basin-and-grange-album.jpg',
  bandSite: 'https://www.basinandgrange.com',
  albumPage: 'https://www.basinandgrange.com/albums',
  listen: 'https://lnkfi.re/bng-walkalbum',
  radio: 'https://airplaydirect.com/music/basinandgrange2024/',
};

/** Link to the contact form with the subject line filled in. */
export function contactHref(subject?: string): string {
  return subject ? `/contact?subject=${encodeURIComponent(subject)}` : '/contact';
}

export interface NavLink {
  label: string;
  href: string;
  blurb?: string;
}

export interface NavGroup {
  label: string;
  /** Path prefixes that mark this group as active. */
  match: string[];
  links: NavLink[];
}

export type NavItem = NavLink | NavGroup;

export const isGroup = (item: NavItem): item is NavGroup => 'links' in item;

export const nav: NavItem[] = [
  {
    label: 'Acoustic',
    match: ['/microphones', '/chester', '/software'],
    links: [
      { label: 'Chester', href: '/microphones/chester', blurb: 'Upright bass microphone' },
      { label: 'AcoustiMatch', href: '/software/acoustimatch', blurb: 'Make a pickup sound like a mic' },
    ],
  },
  {
    label: 'Electric',
    match: ['/pedals', '/amplifiers'],
    links: [
      { label: 'Pedals', href: '/pedals', blurb: 'Q-Tune, The Flick and more' },
      { label: 'Amplifiers', href: '/amplifiers', blurb: 'Tube amp builds' },
    ],
  },
  { label: 'Records', href: '/records' },
  { label: 'For Sale', href: '/for-sale' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
];
