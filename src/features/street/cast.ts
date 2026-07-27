/**
 * The people. This module is the feature.
 *
 * House rules, which are not negotiable and are enforced by street.copy.test.ts:
 *
 *  - The syndicate is **the Body Corporate**: a hijacked-building landlord operation that runs retail
 *    narcotics as a property business, with levies, trustees, an AGM and arrear subs. Its membership
 *    is mixed on purpose — Igbo, Zulu, Sotho, Mandarin, an accountant — so no nationality carries the
 *    crime. The Nigerian-South African characters are its most competent operators, which is the
 *    point: they are sharper than the player, they run a better business than the player, and they
 *    have the best lines in the game.
 *  - Naija pidgin is FLAVOUR, not a wall: "small small", "no wahala", "abi", "sha", "oga". Never so
 *    thick that an outsider loses the sentence. Attitude and rhythm carry it, the way GTA's Yardies
 *    did.
 *  - "Sex worker" in every string the player can see. Never "prostitute", never "john". Slurs exist
 *    only in the mouth of a character the game is visibly mocking — which is the radio host, and the
 *    joke is always on him.
 *  - Nothing sexual exists in this build, including unreachable content. The interlude is a card of
 *    conversation on a black screen and that is the whole of it.
 */
import type { Refusal, Shift } from './rules';

export interface Dealer {
  readonly name: string;
  /** Sits under the name on the menu card. */
  readonly tag: string;
  /** Cycled by visit count, so a regular customer never hears the same hello twice running. */
  readonly greet: readonly string[];
  readonly bought: string;
  readonly sold: string;
  readonly levyPaid: string;
  readonly arrears: string;
  readonly locked: string;
  readonly banned: string;
  readonly broke: string;
}

/** One dealer per block, cast in declaration order against the derived site list. */
export const DEALERS: readonly Dealer[] = [
  {
    name: 'Chidi Nwosu', tag: 'Trustee, retail. Keeps a ledger you are on page four of.',
    greet: [
      'You again. Good. A customer who comes back is a customer with a system.',
      'Small small. Nobody in this city got rich in one afternoon, and the ones who tried are in Sun City with a cellmate called Uncle.',
      'I do not serve men in a hurry. A man in a hurry is a man being followed, and I have a lease.',
      'Everybody wants the corner. Nobody wants the invoice. Sit, sit — the invoice is coming.',
    ],
    bought: 'Count it in front of me. I am not going to be the reason you learn to count.',
    sold: 'Fine. The book will show it by Friday. The book always shows it by Friday.',
    levyPaid: 'Paid in full. You are now the only member in good standing on this entire block.',
    arrears: 'You owe subs. I like you, but I like the book more, so the price is up until you pay.',
    locked: 'Not yet. That clientele needs patience and you still walk like a man late for something.',
    banned: 'No. You put your hands on somebody who works this street. The trustees heard before I did.',
    broke: 'Come back with money. This is a business, not a church, and even the church takes cash.',
  },
  {
    name: 'Blessing Adeyemi', tag: 'No haggling. She has heard your opening offer before, from better men.',
    greet: [
      'You want to negotiate? Go to Sandton. They love a meeting there — two hours, no decision, free biscuits.',
      'The price is the price. I did not set it. The trustees set it, in a boardroom, with a slideshow about stakeholder alignment.',
      'Ah-ah. You are standing on my light. There is one working streetlamp on this road and you are wearing it.',
      'How far. Talk fast, I close at the same time as the clinic and the clinic closed an hour ago.',
    ],
    bought: 'Good. Now walk like you are going somewhere boring.',
    sold: 'I will move it before the load-shedding. Everything sells better in the dark, including nonsense.',
    levyPaid: 'Look at that. A man who pays. Do not tell the others, they will want a certificate.',
    arrears: 'You owe. Until you pay, you buy at the tourist price, and I will not feel bad about it.',
    locked: 'No. Come back when your name means something in the book.',
    banned: 'Get off my corner. Every woman on this road has your car written down and so do I.',
    broke: 'With what money? Your face? Your face is not accepted here.',
  },
  {
    name: 'Sipho Radebe', tag: 'Trustee, enforcement. Prefers the word "compliance".',
    greet: [
      'Levies are due on the first. The lift has not worked since 2019. These two facts are unrelated, and if you say otherwise, that is defamation.',
      'There is a laminated notice in that lobby. Nobody has read it. That is not the notice’s fault.',
      'Forty flats, one connection, one geyser between them. We are not a syndicate, my bru, we are a service delivery partner.',
      'Sharp. Do your business, keep your voice down, the aunties upstairs are watching the soapie.',
    ],
    bought: 'Noted. Your account is in good standing, which is more than the municipality can say.',
    sold: 'Received. I will do the paperwork, which in this case is my memory.',
    levyPaid: 'Receipt? There is no receipt. There is me, remembering that you are fine.',
    arrears: 'Arrear subs. I am obliged to mention it every time I see you. That is the whole job.',
    locked: 'Not at your level. The AGM sets levels and the AGM is in November.',
    banned: 'You hurt someone under this roof. The building has a view of the whole street, my bru. Every window.',
    broke: 'No money, no service. Ask the municipality how that feels.',
  },
  {
    name: 'Emeka "Books" Ofori', tag: 'Keeps the levy book. The book is beautiful.',
    greet: [
      'Everything that enters this corner gets a line in my book. Your name is on page four. Page four is a good page.',
      'I was an accountant. I am still an accountant. The clients simply stopped issuing invoices.',
      'You see this column? Arrears. You see this column? Regret. They are the same column, I just like the word.',
      'No wahala. Cash, count, line, done. Anybody who wants a conversation must first want a receipt.',
    ],
    bought: 'Entered. Date, amount, and a small note about your handwriting.',
    sold: 'Accepted at book value, less the service charge, which is on page one, which you did not read.',
    levyPaid: 'Beautiful. I am going to rule a line under that in red.',
    arrears: 'Page four has become untidy. Untidy pages attract trustees. Pay.',
    locked: 'The book does not know you well enough for that yet. Trade more, be boring, come back.',
    banned: 'I have closed your page. Do not ask me to reopen it — the trustees write in that section.',
    broke: 'A shortfall. My least favourite word, and I know "audit".',
  },
  {
    name: 'Mr Fan', tag: 'Freight. Insists the distinction matters, and it does, to his accountant.',
    greet: [
      'I am not in drugs. I am in freight. Sometimes freight is in drugs. My accountant enjoys the distinction.',
      'Container comes to Durban, truck comes to Joburg, nobody looks in the truck because the paperwork is perfect. The paperwork is the product.',
      'You are late. Not for me — for the price. The price left an hour ago.',
      'Everything on this corner arrived on a truck. Including, if we are honest, the corner.',
    ],
    bought: 'Shipped. From here it is your logistics problem, and logistics is where amateurs die.',
    sold: 'Absorbed into inventory. You will not see it again and neither will anyone with a warrant.',
    levyPaid: 'Settled. I appreciate a man who treats a levy like an invoice.',
    arrears: 'Your account is overdue. I do not send letters. I adjust prices.',
    locked: 'Volume like that requires a relationship. We are at the small-talk stage.',
    banned: 'No. You are a liability now, and I insure everything.',
    broke: 'Insufficient funds. Very common. Very boring.',
  },
  {
    name: 'Kagiso "Kaya" Molefe', tag: 'Private members’ club. Laminated card. Horticultural services agreement.',
    greet: [
      'It is a private members’ club, my bru. You are a member now — here is your laminated card. Do not laminate anything else, it goes to your head.',
      'Selling is illegal. Growing for yourself is completely fine. So I do not sell. I provide horticultural services and you tip enthusiastically.',
      'There is a signed Act and it is not in force, so the country is legally in a shrug. I have framed the shrug.',
      'Cops walked past this door for eight months. Then a news crew came, and suddenly it was Operation Something.',
    ],
    bought: 'Enjoy responsibly, which on this street means indoors and with the curtains closed.',
    sold: 'Into the members’ reserve it goes. The members are me and a laminator.',
    levyPaid: 'Subs paid. You are now more compliant than three quarters of Sandton.',
    arrears: 'Ja, your subs. The committee has noticed. The committee is me, and I have noticed.',
    locked: 'That is not a members’ club product, my bru. That is a different building with worse lighting.',
    banned: 'Nope. Word came down the road before you did. Go home.',
    broke: 'A membership has a fee. That is the entire concept of a membership.',
  },
];

export interface Worker {
  readonly name: string;
  readonly tag: string;
  readonly shift: Shift;
  /** She sets it. It is stated up front, in rand, every single time. */
  readonly price: number;
  /** What the information costs. Always less than the fare, on purpose. */
  readonly infoPrice: number;
  readonly greet: readonly string[];
  readonly agree: string;
  /** The interlude card: the conversation after, because that is what the scene is about. */
  readonly after: string;
  /** Rotating street knowledge, sold or given. The tip line is generated separately. */
  readonly info: readonly string[];
  readonly refuse: Readonly<Record<Refusal, string>>;
}

/** One worker per block. Named, shifted, priced, and able to say no. */
export const WORKERS: readonly Worker[] = [
  {
    name: 'Nomsa Dube', tag: 'Six to six on this block for six years. Keeps a list of cars.',
    // Six till six. Widened from 19h–5h so the introduction block's night half meets its day half
    // (Gugu, RELIEF_WORKER_CAST) with no gap: at the nearest corner to the spawn kerb there is
    // always somebody on the pavement, whatever time the player starts.
    shift: { start: 18, end: 6 }, price: 150, infoPrice: 60,
    greet: [
      'Evening. R150, short time, and you drive round the corner — not here, here is where I stand.',
      'You are back. Fine. Same price. I do not do specials, this is not Checkers.',
      'Before anything: I write cars down. Not a threat, just admin. Everybody on this road keeps the same book.',
    ],
    agree: 'Right. Round the corner, kill the lights, and do not touch the radio, that station is a crime.',
    after: 'Afterwards she talks, because she has been on this block since six and you are the first person tonight who has not been an idiot. She tells you what she has actually seen from here.',
    info: [
      'The blue lights on the M2 tonight are not police. They are a metro cop moonlighting, and he only stops nice cars.',
      'That building with no windows on the corner — go in the side, never the lobby. The lobby has a man with a clipboard and a bad attitude.',
      'Load-shedding hits this block at nine. The one lamp that stays on is on the hospital circuit. That is where everyone stands, including people you do not want to stand next to.',
    ],
    refuse: {
      banned: 'No. You are on the list, my friend. Somebody got hurt and the whole road has your car. Twelve hours, minimum, and that is the road being generous.',
      'off-shift': 'I am not working yet. I start at six. Go and do something legal for a few hours.',
      moving: 'Stop the car properly. I am not talking to a moving vehicle, I have knees.',
      'police-car': 'A JMPD car. Are you serious. Coetzee took R200 off me on Tuesday and confiscated my condoms as evidence. Drive away.',
      wreck: 'That car is smoking. I am not getting into a story that ends with me pushing.',
      broke: 'You do not have it. That is fine, it happens, but it happens somewhere else.',
      busy: 'Give me a minute. I am a person, not a rank.',
    },
  },
  {
    name: 'Precious Mabaso', tag: 'Unimpressed by you, the by-law officer, and the weather.',
    shift: { start: 20, end: 4 }, price: 140, infoPrice: 50,
    greet: [
      'R140. Round the corner. And if you are going to be strange, be strange somewhere with better lighting.',
      'Hello again. Still R140. Inflation has not reached this pavement, unlike everything else.',
      'You know the officer fined me R300 for "loitering"? He does not write a docket. He writes a price.',
    ],
    agree: 'Fine. Drive. Slowly, like a person with a licence, which I doubt.',
    after: 'She talks the whole way back, mostly about the by-law officer, and somewhere in the middle she tells you something you can use.',
    info: [
      'Coetzee, the by-law man, works Thursdays and he is on someone’s payroll, because he only ever raids the corners that stopped paying.',
      'There is a taxi rank two blocks up where nobody parks, ever. Ask yourself why nobody parks there, then do not park there.',
      'The scrap yard takes copper at four in the morning, no questions. That is where your stolen geyser went, and your neighbour’s.',
    ],
    refuse: {
      banned: 'Hayibo. No. We warned each other about you before your car even turned in. That is how it works here.',
      'off-shift': 'Not yet. Eight o’clock. I am currently having supper like a normal human being.',
      moving: 'Are you going to stop, or are we doing this at 40 kilometres an hour?',
      'police-car': 'In a metro car? No. I have had that conversation and it cost me R200 and my dignity.',
      wreck: 'That thing is a wreck. I have standards and they are already quite low.',
      broke: 'No money, no conversation. I am not a charity, the charity is on Twist Street and they close at six.',
      busy: 'Not right now. Give me five minutes and some peace.',
    },
  },
  {
    name: 'Lerato Khoza', tag: 'Day shift, because the crèche closes at five.',
    shift: { start: 10, end: 18 }, price: 180, infoPrice: 70,
    greet: [
      'Day rate is R180. Yes, more. I am the only one out here in daylight, which is exactly why it costs more.',
      'You again, in the afternoon. A man with a flexible schedule. Suspicious, but not my business.',
      'I finish at five. Crèche closes at half past and they charge by the minute, which is more than I do.',
    ],
    agree: 'Round the corner then, and quickly — I have a five o’clock and she is four.',
    after: 'She checks the time twice, then tells you the thing she has been watching all week from this pavement.',
    info: [
      'The day shift sees the deliveries. Whoever is stocking that corner drives a white bakkie with a government disc, and I did not say that.',
      'Two of the men on this road are not dealers, they are collecting levies. Different job. Worse job.',
      'If you want the corner that is paying properly, it is never the busy one. Busy means everyone already sold there.',
    ],
    refuse: {
      banned: 'No. And do not stand there looking wounded, we all know what you did.',
      'off-shift': 'I only work days. Come back at ten, when the sun is up and everyone can see your face.',
      moving: 'Stop the car. I am not running alongside you like a bad film.',
      'police-car': 'A JMPD vehicle. Absolutely not. I have a child and a very good memory.',
      wreck: 'That car is a write-off with a driver in it. No.',
      broke: 'R180, and you are not carrying R180. Come back when the sum works.',
      busy: 'Not this minute. Go and buy a cold drink, I will be here.',
    },
  },
  {
    name: 'Zanele Sithole', tag: 'Trained as a nurse. Still the person everyone comes to first.',
    shift: { start: 21, end: 5 }, price: 200, infoPrice: 80,
    greet: [
      'R200. I am expensive because I am careful, and careful is the only thing worth paying for out here.',
      'You look terrible. Not judging — observing. It was the job for four years.',
      'Everyone on this road brings me their injuries before they bring them to Hillbrow Clinic. The clinic asks questions. I ask better ones.',
    ],
    agree: 'Round the corner. Not the one with the lamp — the other one.',
    after: 'She talks like someone doing a handover at shift change: brisk, complete, and entirely accurate.',
    info: [
      'Three gunshot cases through the clinic this week, all from the same two blocks. Whatever is happening there is not over.',
      'The nyaope on this side of town is being cut with something new. I can tell from the wounds. Nobody upstream cares, which tells you where upstream is.',
      'A police van sits behind the church every night between one and three. It is not a stakeout. It is a nap.',
    ],
    refuse: {
      banned: 'I have treated the person you hurt. Get away from me.',
      'off-shift': 'I start at nine. Before that I sleep, which is medically indicated.',
      moving: 'Stop the vehicle. Handbrake. Thank you.',
      'police-car': 'No. Not in that. Do you know how many women I have patched up after "a lift" in one of those?',
      wreck: 'You are driving something that is going to catch fire. I have seen the burns. No.',
      broke: 'R200 or nothing, and nothing is a perfectly respectable outcome.',
      busy: 'Give me a moment. Even a shift has a tea break.',
    },
  },
  {
    name: 'Faith Nyathi', tag: 'From Bulawayo. Funnier about the by-law officer than he deserves.',
    shift: { start: 18, end: 2 }, price: 130, infoPrice: 50,
    greet: [
      'R130, round the corner. And no, before you ask, my papers are in order and it has never once helped.',
      'The officer came again. He does not arrest. He fines. Cash, no docket, and he takes the condoms as "evidence" — evidence of what, Coetzee? Health?',
      'The radio says people like me are the crime. The radio has not met Coetzee.',
    ],
    agree: 'Drive. Round there, past the skip, where the man with the clipboard cannot see.',
    after: 'She does an impression of the by-law officer that is genuinely excellent, and then, without changing tone, tells you something true.',
    info: [
      'Everything on that corner comes through one flat on the fourth floor. The building has no water. The flat has a fridge.',
      'When the radio host starts shouting about foreigners, there has been a raid somewhere and someone respectable needs the airtime.',
      'The pharmacist on the main road is the one everyone calls the kingpin. He is not. He is a pharmacist. He is also the only person here who will not rob you.',
    ],
    refuse: {
      banned: 'No. We told each other. That is the only protection we have and it works.',
      'off-shift': 'Six o’clock I start. Until then I am a private citizen with a kettle.',
      moving: 'Stop the car, my friend, this is not a drive-through.',
      'police-car': 'In that? He would love that. No.',
      wreck: 'That car has been shot. I can see the holes from here. No.',
      broke: 'You are short. Everyone is short. Come back when you are less short.',
      busy: 'Not now. Two minutes.',
    },
  },
  {
    name: 'Thandi Mokoena', tag: 'Eleven years on this block. Knows every plate that turns in.',
    shift: { start: 19, end: 3 }, price: 160, infoPrice: 60,
    greet: [
      'R160. Eleven years I have stood here, so believe me when I say the price is the price.',
      'I know your car. I know most cars. It is not a talent, it is just eleven years and nothing else to look at.',
      'New driver on this road tonight, circling. If he circles again I am going inside and so should you.',
    ],
    agree: 'Round the corner. And drive properly, this street has children in it even at this hour.',
    after: 'Eleven years of watching one street turns out to be a qualification, and she gives you the short version.',
    info: [
      'The corner everyone drives past is the one paying. The busy one has been sold out since Tuesday.',
      'That white bakkie with the government disc comes twice a week. It never delivers to the same corner twice running.',
      'There is a car that circles this block every night at exactly the same time. Same driver. Nobody has ever seen him stop.',
    ],
    refuse: {
      banned: 'You are the reason we keep a list. No.',
      'off-shift': 'Seven o’clock. Eleven years, same time, you can set a watch by me.',
      moving: 'Stop. Properly. Handbrake up.',
      'police-car': 'No metro cars. That is not a preference, that is a rule.',
      wreck: 'Look at your car. Then look at me. Now you understand.',
      broke: 'You are short and I am tired. Both are fixable, yours first.',
      busy: 'Wait a bit. Even eleven years needs a sit down.',
    },
  },
  // INDEX 6 — THE DAYLIGHT RELIEF, and by pinning (street.state.RELIEF_WORKER_CAST) the person you
  // meet first. She works the introduction block opposite Nomsa's six-to-six, so that corner is
  // never empty whatever the clock says, and her entire character is that she explains things and
  // then explains them again. She is the answer to "the person stopped telling me".
  {
    name: 'Gugu Ndlovu', tag: 'Daylight on the CBD kerb. Will explain it twice and not make a thing of it.',
    shift: { start: 6, end: 19 }, price: 120, infoPrice: 40,
    greet: [
      'R120, and before you ask — yes I am out here in the daylight, no I am not lost, this is a job with hours.',
      'You look like you have been walking around trying to work out how this street works. Ask me. I am cheaper than finding out.',
      'You again. Ask me anything twice, I do not charge for the second time. Half this road would still be lost otherwise.',
      'Morning. The man on that corner sells, I stand on this one, and everybody pretends the building above us is flats.',
    ],
    agree: 'Round the corner then. Not far — I am back here for the school run and the school run does not wait.',
    after: 'She talks all the way back, and it is not small talk: she lays out who is on which corner, what they will pay, and which one is a waste of petrol, twice, so it sticks.',
    info: [
      'Everything you want to know is on that kerb in front of you. The lights are corners. Follow one, there is a person under it.',
      'Ask any of us where the money is and we will tell you, every time, for nothing. We are not a puzzle, we are a road.',
      'Day shift sees the bakkie, night shift sees the buyers. Between us there is nothing about this street we do not know.',
    ],
    refuse: {
      banned: 'No. You hurt somebody who works here and the whole road heard within the hour. Wait it out.',
      'off-shift': 'I start at six. Come back when it is light, or go and see Nomsa — she has this kerb until then.',
      moving: 'Stop the car first. I am not shouting at a moving vehicle in daylight.',
      'police-car': 'A JMPD car, in the middle of town, at this hour. Be serious.',
      wreck: 'That car is finished. Take it to the spray shop before somebody takes it off you.',
      broke: 'R120 and you do not have R120. That is fine. Come back, I am here all day.',
      busy: 'Give me a minute, I am a person. I will still be on this corner in five.',
    },
  },
];

/**
 * The Blame Ticker in one line. Every crime the player commits comes back off the drive-show as
 * someone else's fault — and the joke lands on the host, every time, which is where South African
 * humour already aims it. Cycled, never random.
 */
export const RADIO_BLAME: readonly string[] = [
  'Highveld Talk: "I’ll say it again, callers — this used to be a decent city." Braam has not left the studio since 2019.',
  'Highveld Talk: a caller from Northcliff is certain the men behind it are "not from here". Braam agrees instantly and takes an ad break.',
  'Highveld Talk: "Sources say the syndicate is run by a Nigerian pharmacist." The pharmacist has issued a statement. The statement is: "I am a pharmacist."',
  'Highveld Talk: a break-in in Parkhurst, and Braam has already decided who did it, and it rhymes with "foreigners".',
  'Highveld Talk: tonight’s show is sponsored by a logistics company in Sandton. Braam has never once asked what it moves.',
  'Highveld Talk: "Where are these drugs coming from?" A commission of inquiry has an answer and it is thirteen police officers long. Braam goes to traffic and weather.',
];

/** Laminated-notice comedy for the levy rows. The lift has not worked since 2019. */
export const LEVY_NOTES: readonly string[] = [
  'NOTICE: levies due 1st. Lift out of order. Water Thursday. — The Trustees',
  'NOTICE: no washing on balconies. No visitors after 22h00. No exceptions. — The Trustees',
  'NOTICE: the AGM is postponed. The slideshow is not. — The Trustees',
  'NOTICE: arrear subs will be handled internally. Internally. — The Trustees',
];

/** The wholesale line at Trustee rank: competent, expensive, faintly bored of being asked. */
export const FIXER = {
  name: 'Dr Ifeanyi Okonkwo',
  tag: 'Pharmacist. Forty hours a week. Called a kingpin by a man on the radio.',
  greet: [
    'You want the wholesale. Everyone eventually wants the wholesale. Sit down, I am counting Schedule 5s and I lose my place.',
    'Every week that man calls me a kingpin on air. Every week I am here dispensing metformin to your aunt. Both things are true and only one pays.',
  ],
  reveal:
    'Here is the part nobody puts on the radio. The kilo you keep asking about did not come off a boat. It came out of an evidence store, signed for twice by the state, and it left in a car with blue lights fitted by a man who is currently in court about the lights and not the cargo. It ended up at a braai on a golf estate. So no, oga — you are not entering the underworld. You are entering the private sector.',
  farewell: 'Take your paperwork. Yes, there is paperwork. There is always paperwork, that is the actual lesson.',
} as const;

/** Promotion beats. Short, celebrated, and immediately spendable. */
export const PROMOTIONS: readonly { readonly title: string; readonly line: string }[] = [
  { title: 'Corner', line: 'You are on the corner. Everybody starts on the corner.' },
  { title: 'Runner — the book has your name in it', line: 'Levy price from now on, and thirty units in your hands. Page four, remember.' },
  { title: 'Trustee — you hold a key and an opinion at the AGM', line: 'Eighty units, best price on the road, and a laminated card you did not ask for.' },
];

export function dealerFor(index: number): Dealer { return DEALERS[index % DEALERS.length]!; }
export function workerFor(index: number): Worker { return WORKERS[index % WORKERS.length]!; }
export function cycle<T>(lines: readonly T[], visit: number): T { return lines[Math.abs(Math.floor(visit)) % lines.length]!; }
