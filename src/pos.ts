import natural from "natural";

export interface TaggedWord {
  token: string;
  tag: string;
}

const { BrillPOSTagger, Lexicon, RuleSet } = natural;

export class PosTagger {
  private readonly tagger: InstanceType<typeof BrillPOSTagger>;

  constructor() {
    const lexicon = new Lexicon("EN", "NN", "NNP");
    const ruleSet = new RuleSet("EN");

    this.tagger = new BrillPOSTagger(lexicon, ruleSet);
  }

  tag(tokens: string[]): TaggedWord[] {
    return this.tagger.tag(tokens).taggedWords;
  }
}
