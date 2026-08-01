import { Zap, Coins, ShoppingBag, ExternalLink } from 'lucide-react';

interface ProCard {
  id: string;
  icon: typeof Zap;
  title: string;
  description: string;
  label: string;
  href: string;
}

const CARDS: ProCard[] = [
  {
    id: 'pro-appointment',
    icon: Zap,
    title: 'BUY PRO APPOINTMENT',
    description: 'Direct WhatsApp Consultation for custom dorking scripts and OSINT audits.',
    label: 'WhatsApp Chat',
    href: 'https://wa.me/919898048483',
  },
  {
    id: 'donation',
    icon: Coins,
    title: 'DONATION SYSTEM',
    description: 'Support open-source OSINT development and database updates.',
    label: 'Support Project',
    href: 'https://docs.google.com/forms/d/e/1FAIpQLScJ7WjuxEXqdoSlUtxN7NQ8UeKpbEAeA9iIO-IXOmBmYzlLHQ/viewform',
  },
  {
    id: 'store',
    icon: ShoppingBag,
    title: 'OFFICIAL DIGITAL STORE',
    description: 'Browse official security tools, custom software packs, and OSINT guides.',
    label: 'Digital Store Catalog',
    href: 'https://wa.me/c/919898048483',
  },
];

export default function ProHub() {
  const open = (href: string) => () => {
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-widest text-matrix uppercase flex items-center gap-2">
          <ExternalLink className="w-4 h-4" /> Pro Hub
        </h2>
        <span className="text-[10px] text-slate-600">official resources & support</span>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              className="panel p-5 flex flex-col gap-4 border-matrix/20 hover:border-gold/50 hover:shadow-neon transition-all"
            >
              <div className="flex items-center gap-2">
                <Icon className="w-5 h-5 text-gold" />
                <h3 className="text-xs font-bold tracking-widest text-slate-100">{card.title}</h3>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-400">{card.description}</p>
              <button
                onClick={open(card.href)}
                className="mt-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-gold/60 bg-gold/10 text-gold text-xs font-semibold hover:bg-gold/20 transition-colors"
              >
                {card.label}
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-slate-600">
        External links open in your default browser. These resources are operated independently of the
        gateway — proceed at your own discretion.
      </p>
    </div>
  );
}
