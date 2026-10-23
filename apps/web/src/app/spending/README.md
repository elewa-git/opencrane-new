# Spending

This folder shows the Spending page for owners and admins. They can see charges and money set aside for unfinished calls, change budgets and review costs whose final outcome needs a decision.

## What it is responsible for

- Shows global, paying-group and assistant budgets at `/org/spending`. A paying group is the group whose budget pays for work.
- Separates charged money from held money, meaning an amount set aside before a call. Running calls stay in a waiting count.
- Edits monthly ceilings, daily safety caps and the default group for new personal work, using whole euro cents.
- Keeps typed values when a selected group or shared assistant is unavailable and asks for another choice.
- Shows recorded evidence for a held amount, then records either the real charge or the return of unused money.
- Keeps pending decisions with their original references while another held amount is reviewed. Access loss clears budgets, references and the open drawer.

## Main files

| File | What it does |
| --- | --- |
| `spending.*`, `spending-reads.ts`, `spending-view.ts` | Load budgets and held costs and coordinate page status. |
| `budget-limit-editor.*`, `money-card.*`, `spending-money.ts` | Edit limits and display amounts. |
| `held-effects-list.*`, `effect-evidence-list.*` | List amounts needing review and their recorded evidence. |
| `effect-resolution-drawer.*`, `effect-rules.ts` | Review a final charge or release and check the submitted evidence. |

## How it connects

[Organisation](../organisation/README.md) supplies navigation.
[Models & providers](../models/README.md) links here for budgets.
[Shared controls](../ui/README.md) supply the review drawer.
[The server](../../../../server/README.md) supplies amounts and saves decisions;
the browser does not decide whether an AI call has budget left.
