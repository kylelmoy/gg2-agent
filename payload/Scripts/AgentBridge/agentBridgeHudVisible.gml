// agentBridgeHudVisible(show)
// Activates (show=true) or deactivates (show=false) every HUD-drawing object this
// tooling knows about, for gg2_area_shot's overlay suppression.
//
// Deactivating, not visible = false: most of these draw through their own Draw event
// code rather than GM8's automatic sprite draw, so visible alone does nothing for them
// - confirmed live, 2026-08-20 (with(HUD) visible = false left KothHUD's timer and lock
// icon fully intact; instance_deactivate_object(HUD) removed both). The two exceptions,
// TeamSelectController and ClassSelectController, do respect visible - they have no
// custom Draw event of their own, so toggling it is enough and does not need
// deactivating (which would also stop whatever Step-event logic they run).
//
// instance_deactivate_object(HUD) reaches every gamemode HUD (KothHUD, CTFHUD, ...)
// without listing them individually, the same parent-inclusive behaviour this codebase
// already relies on elsewhere (basicRoomSetup.gml's with(ControlPoint)) - all of them
// are children of HUD (Objects/Overlays/HUD.xml).
//
// Called from two places: once, directly, before FREEZE - and again from
// agentBridgeShot every time it is about to redraw a frozen frame, because
// instance_activate_all() (needed to make a frozen game draw anything real at all)
// silently undoes this otherwise. See agentBridgeShot for that half.

var show;
show = argument0;

if(show)
{
    instance_activate_object(HUD);
    instance_activate_object(ScoreTableController);
    instance_activate_object(KillLog);
    instance_activate_object(RespawnTimer);
    instance_activate_object(SentryHealthHud);
    instance_activate_object(NutsNBoltsHud);
    instance_activate_object(SandwichHud);
    instance_activate_object(UberHud);
    instance_activate_object(StickyCounter);
    instance_activate_object(AmmoCounter);
    instance_activate_object(DeathCam);
    instance_activate_object(HealthHud);
    instance_activate_object(MedicRadar);
    instance_activate_object(WinBanner);
    instance_activate_object(HealedHud);
    instance_activate_object(HealingHud);
    instance_activate_object(NoticeO);
    instance_activate_object(Spectator);
    with(TeamSelectController) visible = true;
    with(ClassSelectController) visible = true;
}
else
{
    instance_deactivate_object(HUD);
    instance_deactivate_object(ScoreTableController);
    instance_deactivate_object(KillLog);
    instance_deactivate_object(RespawnTimer);
    instance_deactivate_object(SentryHealthHud);
    instance_deactivate_object(NutsNBoltsHud);
    instance_deactivate_object(SandwichHud);
    instance_deactivate_object(UberHud);
    instance_deactivate_object(StickyCounter);
    instance_deactivate_object(AmmoCounter);
    instance_deactivate_object(DeathCam);
    instance_deactivate_object(HealthHud);
    instance_deactivate_object(MedicRadar);
    instance_deactivate_object(WinBanner);
    instance_deactivate_object(HealedHud);
    instance_deactivate_object(HealingHud);
    instance_deactivate_object(NoticeO);
    instance_deactivate_object(Spectator);
    with(TeamSelectController) visible = false;
    with(ClassSelectController) visible = false;
}
