## How would you create an agent that's really good at checking citations?
The idea is to try and resolve the citation to a document+section first, give the model as little as possible to read, then just use code to double check the model's answer. For many cases where the citation string already tells us exactly where to look, I let code do that lookup instead of asking the model to find it.

## How would you parse the individual documents in a way where you can understand claims and citations?
I started with a dumb parser at first. It just read things like `PMC1234` and plain table numbers like "Table 14". As expected, testing real citations broke it right away. (e.g: `CSR-ABC101, Table 14.2.1` got read as "no document at all." `Table 14.2.1` got cut down to "Table 14," which pointed at the wrong table). 
 
The fix was to stop guessing with pattern matching and instead look up the real document and table IDs from a proper store. Once I did that, table references matched almost every time, and I could recover most missing citations too, by scanning for numbers in the text and matching them back to the right table.

Note: I also built a path for PDFs as it was relatively cheap to build.

## How would you benchmark this citation agent? How do you create the ground truth? Feel free to leverage Wikipedia and other large online public datasets for this.
Since the start, I was leaning towards building my own datasets in a way for this exercise but decided to do some research for public ones first. 
I started with Wikipedia style fact checking datasets but I don't think they were a good fit as they're just are about general facts in plain text. What I needed to test was numbers in tables, and whether a sentence correctly describes what's in a specific row of a specific table. Trial papers turned out to be the closest public stand in for a real clinical study report, since they also have real tables tied to real claims, made by real scientists.
 
So I went with building my own sets instead:
 
* A set of real claims from trial papers, linked to their own tables, with some of them changed on purpose to be wrong
* A second set where I only change small details, like flipping a result's direction or its statistical significance, while keeping every number the same. This turned out to be a much harder test, since a simple check for wrong numbers can't catch these.
* A small, hand written set of softer claims, like "the drug was well tolerated," since none of the other sets test whether the model can judge a claim that isn't just a number.


## What error metrics do you use? How do you interpret them?

1. How many bad citations did we catch
2. How many good citations did we wrongly flag. I tried optimizing by thinking from the reviewer's POV. For every real mistake we catch, how many false alarms do they have to read through to find it.
 
Also, technically I believe my tests sets are quite small in comparison to real world data. With only around 50 examples in a group, a couple of examples flipping from right to wrong can look like a big swing, when it's really just noise.

## How do you design the agent? What tools do you give it? How do you avoid the context blowing up?

I started with a general agent that could freely search across every document. It got the same accuracy as just handing the model the exact table it needed, but it cost three times as much and took twice as long. So I changed the design: look up the citation directly first, and only fall back to a search agent when the citation points at a whole document instead of one table.
 
I gave the agent just the tools it needs, not just give it everything: list the documents, get an outline, read one section at a time, search by keyword, and submit a final answer.

Every citation check starts with a fresh, empty context. Every tool result is capped and paginated, so the model never reads more than it needs. And there's a hard limit on how many tool calls one check can use.
 
On top of all that, before I trust a "supported" answer from the model, plain code double checks it: is the quote actually real, are the numbers in the answer actually in the source, does the direction of the result match. If any of these fail, the model is asked once more, with a note naming the problem.

## What agent is best if we just care about accuracy? What wins if we care about latency (maybe we want to give users feedback as they edit documents)? What wins if we need to keep costs reasonable.
 
For accuracy, the best setup uses a frontier model plus a small set of extra checks I wrote in code, nudging it to look for things like overstated claims or unfair comparisons. Without those extra checks, every strong model I tried hit the same wall and missed the same subtle mistakes. With them, the best setup catches close to everything.
 
For latency, meaning fast feedback while someone is editing a document, a small, cheap model gives an answer in about a second. That's the setup I'd use if the goal is instant feedback in an editor, even if it's not the most accurate.
 
In the end, I went with a hybrid approach. A cheap model checks everything first, and a stronger model only re-checks the ones that got flagged or that hit one of the extra checks I mentioned. This gets close to the top accuracy for a fraction of the price of always using the strong model.

## How good is this agent. Is it a preliminary check but each citation should be checked again by people? Or is it something a company can truly rely on?

Right now, this is a first pass that cuts down what a person has to re-read/review. It's not something I'd trust to sign off on its own yet.
 
It catches wrong numbers, wrong tables, and wrong papers almost every time, without much effort. It catches softer, overstated claims mostly when I've already written a specific check for that pattern, and when I tested it on new patterns I hadn't written checks for, it did much worse. My hand written test set of soft claims scored perfectly across almost every model I tried, which actually worries me a bit. It tells me that test was too easy, not that the agent is great. I believe real world claims are messier than the ones I wrote by hand.
 
## Try lots of different models, open and closed source. How does their performance vary? Any qualitative differences in the kinds of errors they make?
 
I tried around 20 models, both open and closed source. I expected a clean ranking from best to worst, but what I actually found was two different possibilities that kept showing up.
 
Some models are "strict." They flag more of everything, including some good citations that didn't need flagging. Other models are "lenient." 
 
Past a certain point, bigger and more expensive models didn't do better. Several expensive models tied a much cheaper one, and missed the exact same mistakes
 
A few smaller, practical issues came up too along the way: broken output from a couple of models, one model rejecting a certain setting when a specific mode was turned on, and stray characters from PDFs occasionally breaking the output format until I fixed the parsing.

## Notes
  
* I tried a few things that didn't make the final version, like comparing every answer against a second model every single time, and a separate viewer app to review results. They didn't turn out to be really useful and didn't dive into this further.
* I also built a small side feature that checks a report's own tables for internal consistency, without needing a model at all. It already found a few real issues on its own.
* There's a mode that suggests fixes for wrong citations and awkward wording. Every citation fix it suggested was correct when I checked it by hand.
* Everything above can be reproduced from a fresh copy of the code. The data and results I used are saved alongside it.