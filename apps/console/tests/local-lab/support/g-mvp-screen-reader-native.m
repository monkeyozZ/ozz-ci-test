#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <dispatch/dispatch.h>
#import <libproc.h>
#import <signal.h>
#import <stdatomic.h>
#import <sys/proc_info.h>
#import <unistd.h>

// Explicit, PID-addressed bridge. `self-test` constructs descriptors only: it
// does not inspect preferences, send events, activate apps, or ask for access.
static NSString * const VoiceOverPath = @"/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOver";
static NSString * const StarterPath = @"/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter";
static NSString * const QuickstartPath = @"/System/Library/PrivateFrameworks/ScreenReader.framework/Versions/A/Resources/VoiceOver Quickstart.app/Contents/MacOS/VoiceOver Quickstart";
static NSString * const SettingsPath = @"/System/Applications/System Settings.app/Contents/MacOS/System Settings";
static NSString * const SettingsApplicationPath = @"/System/Applications/System Settings.app";
static NSString * const ChromePath = @"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
static NSString * const LoginwindowPath = @"/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
// The installed extension declares this legacy bundle identifier and URL
// support; its binary retains the Seeing_VoiceOver navigation anchor.
static NSString * const SettingsURL = @"x-apple.systempreferences:com.apple.preference.universalaccess?Seeing_VoiceOver";
static NSString * const FirstVoiceOverCommand = @"move voiceover cursor to keyboard focus";
static const NSTimeInterval ConsentWaitSeconds = 120.0;
static const NSAppleEventSendOptions SendOptions = NSAppleEventSendWaitForReply | NSAppleEventSendNeverInteract | NSAppleEventSendDontRecord | (NSAppleEventSendOptions)kAEDoNotPromptForUserConsent;
static BOOL ActionPressStarted = NO;
static BOOL ConsentAction = NO;
static atomic_int ConsentRequestCount = 0;
static volatile sig_atomic_t ConsentInterrupted = 0;

static void InterruptConsent(int signalNumber) { ConsentInterrupted = signalNumber; }

static void Require(BOOL value, NSString *code) {
    if (!value) @throw [NSException exceptionWithName:@"ScreenReader" reason:code userInfo:nil];
}

// Box through explicit boolean literals: Objective-C boxes a C comparison or
// logical expression as NSNumber(int), which JSON would emit as 0/1.
static NSNumber *JSONBoolean(BOOL value) { return value ? @YES : @NO; }

static NSString *Now(void) {
    NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
    return [formatter stringFromDate:[NSDate date]];
}

static void Pause(NSTimeInterval seconds) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

static NSDictionary *Identity(pid_t pid) {
    if (pid < 2) return nil;
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return nil;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, path, sizeof(path)) <= 0) return nil;
    return @{
        @"pid": @(pid), @"uid": @(info.pbi_uid), @"processGroup": @(info.pbi_pgid),
        @"path": [NSString stringWithUTF8String:path],
        @"startToken": [NSString stringWithFormat:@"%llu:%llu", info.pbi_start_tvsec, info.pbi_start_tvusec],
        @"startSeconds": @(info.pbi_start_tvsec),
    };
}

static NSDictionary *Expected(NSDictionary *expected, NSArray<NSString *> *allowed) {
    Require([expected isKindOfClass:[NSDictionary class]], @"PROCESS_IDENTITY_REQUIRED");
    NSNumber *pid = expected[@"pid"];
    Require([pid isKindOfClass:[NSNumber class]] && pid.intValue > 1, @"PROCESS_PID_INVALID");
    NSDictionary *current = Identity(pid.intValue);
    Require(current && [current isEqual:expected] && [current[@"uid"] unsignedIntValue] == getuid(), @"PROCESS_IDENTITY_CHANGED");
    if (allowed) Require([allowed containsObject:current[@"path"]], @"PROCESS_PATH_NOT_ALLOWED");
    return current;
}

static NSString *Kind(NSString *path) {
    if ([path isEqual:VoiceOverPath]) return @"voiceover";
    if ([path isEqual:StarterPath]) return @"starter";
    if ([path isEqual:QuickstartPath]) return @"quickstart";
    if ([path isEqual:SettingsPath]) return @"settings";
    return nil;
}

static NSArray *KnownProcesses(void) {
    int count = proc_listallpids(NULL, 0);
    Require(count > 0 && count < 65536, @"PROCESS_ENUMERATION_FAILED");
    NSUInteger capacity = (NSUInteger)count + 1024;
    pid_t *pids = calloc(capacity, sizeof(pid_t));
    Require(pids != NULL, @"PROCESS_ENUMERATION_FAILED");
    int actual = proc_listallpids(pids, (int)(capacity * sizeof(pid_t)));
    NSMutableArray *rows = [NSMutableArray array];
    @try {
        Require(actual >= 0 && (NSUInteger)actual < capacity, @"PROCESS_ENUMERATION_CHANGED");
        for (int index = 0; index < actual; index++) {
            NSDictionary *identity = Identity(pids[index]);
            NSString *kind = identity ? Kind(identity[@"path"]) : nil;
            if (kind && [identity[@"uid"] unsignedIntValue] == getuid())
                [rows addObject:@{@"kind":kind, @"identity":identity}];
        }
    } @finally { free(pids); }
    return [rows sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"identity"][@"pid"] compare:b[@"identity"][@"pid"]];
    }];
}

static NSDictionary *TypedBoolean(id value) {
    if (!value) return @{@"exists":@NO, @"value":[NSNull null]};
    Require(CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(), @"PREFERENCE_NOT_BOOLEAN");
    return @{@"exists":@YES, @"value":JSONBoolean([value boolValue])};
}

static NSDictionary *DiskPreference(NSString *domain, NSString *key) {
    NSString *path = [[NSHomeDirectory() stringByAppendingPathComponent:@"Library/Preferences"] stringByAppendingPathComponent:[domain stringByAppendingString:@".plist"]];
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfFile:path options:0 error:&error];
    if (!data && error.code == NSFileReadNoSuchFileError) return TypedBoolean(nil);
    Require(data && data.length < 8 * 1024 * 1024, @"PREFERENCE_DISK_READ_FAILED");
    id value = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:&error];
    Require([value isKindOfClass:[NSDictionary class]], @"PREFERENCE_DISK_INVALID");
    return TypedBoolean(value[key]);
}

// Pure interpretation, also exercised by the descriptor-only self-test.
static NSDictionary *DesktopFromRows(id rows, NSDictionary *foreground, uid_t uid) {
    NSMutableArray *active = [NSMutableArray array];
    BOOL valid = [rows isKindOfClass:[NSArray class]];
    if (valid) for (id row in rows) {
        if (![row isKindOfClass:[NSDictionary class]]) { valid = NO; continue; }
        id onConsole = row[@"kCGSSessionOnConsoleKey"];
        if (!onConsole || CFGetTypeID((__bridge CFTypeRef)onConsole) != CFBooleanGetTypeID()) { valid = NO; continue; }
        if ([onConsole boolValue]) [active addObject:row];
    }
    NSDictionary *row = valid && active.count == 1 ? active[0] : nil;
    id user = row[@"kCGSSessionUserIDKey"];
    BOOL userMatches = [user isKindOfClass:[NSNumber class]] &&
        CFGetTypeID((__bridge CFTypeRef)user) != CFBooleanGetTypeID() &&
        [user unsignedLongLongValue] == uid && [user doubleValue] == (double)uid;
    id lock = row[@"CGSSessionScreenIsLocked"];
    // The retained locked/unlocked receipts on this host show this key as
    // true when locked and absent when unlocked. Absence is accepted only
    // together with one active matching console UID and a non-loginwindow
    // foreground; unknown types and incomplete observations fail closed.
    BOOL lockKnown = row && (!lock || CFGetTypeID((__bridge CFTypeRef)lock) == CFBooleanGetTypeID());
    BOOL locked = lockKnown && [lock boolValue];
    BOOL foregroundPresent = [foreground isKindOfClass:[NSDictionary class]] &&
        [foreground[@"pid"] intValue] > 1 && [foreground[@"uid"] unsignedIntValue] == uid;
    BOOL loginwindow = [foreground[@"path"] isEqual:LoginwindowPath];
    return @{
        @"source":@"IOConsoleUsers", @"consoleRowsValid":JSONBoolean(valid),
        @"activeConsoleSessions":@(active.count), @"consoleUserMatches":JSONBoolean(userMatches),
        @"screenLockKeyExists":JSONBoolean(lock != nil), @"screenLockKnown":JSONBoolean(lockKnown),
        @"screenLocked":lockKnown ? JSONBoolean(locked) : (id)[NSNull null],
        @"foregroundIsLoginwindow":JSONBoolean(loginwindow),
        @"unlocked":JSONBoolean(valid && active.count == 1 && userMatches && lockKnown && !locked && foregroundPresent && !loginwindow),
    };
}

static NSDictionary *Desktop(NSDictionary *foreground) {
    io_registry_entry_t entry = IORegistryGetRootEntry(kIOMainPortDefault);
    if (!entry) return DesktopFromRows(nil, foreground, getuid());
    CFTypeRef users = IORegistryEntryCreateCFProperty(entry, CFSTR("IOConsoleUsers"), kCFAllocatorDefault, 0);
    IOObjectRelease(entry);
    id rows = users ? CFBridgingRelease(users) : nil;
    return DesktopFromRows(rows, foreground, getuid());
}

static void RequireUnlockedDesktop(void) {
    NSDictionary *foreground = Identity(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
    Require([Desktop(foreground)[@"unlocked"] boolValue], @"DESKTOP_LOCKED_OR_UNCONFIRMED");
}

static NSDictionary *Snapshot(void) {
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    NSDictionary *foreground = Identity(workspace.frontmostApplication.processIdentifier);
    return @{
        @"checkedAt":Now(),
        @"voiceOverEnabled":JSONBoolean(workspace.isVoiceOverEnabled),
        @"accessibilityTrusted":JSONBoolean(AXIsProcessTrusted()),
        @"eventPostingAllowed":JSONBoolean(CGPreflightPostEventAccess()),
        @"foreground":foreground ?: (id)[NSNull null],
        @"desktop":Desktop(foreground),
        @"processes":KnownProcesses(),
        @"activationDisk":DiskPreference(@"com.apple.universalaccess", @"voiceOverOnOffKey"),
        @"scriptingDisk":DiskPreference(@"com.apple.VoiceOver4", @"SCREnableAppleScript"),
    };
}

static id Attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = NULL;
    AXError result = AXUIElementCopyAttributeValue(element, key, &value);
    if (result == kAXErrorNoValue || result == kAXErrorAttributeUnsupported) {
        if (value) CFRelease(value);
        return nil;
    }
    if (result != kAXErrorSuccess && value) CFRelease(value);
    Require(result == kAXErrorSuccess, @"ACCESSIBILITY_READ_FAILED");
    return CFBridgingRelease(value);
}

static NSString *ShortText(id value) {
    if (![value isKindOfClass:[NSString class]]) return @"";
    return [value length] <= 512 ? value : [value substringToIndex:512];
}

static BOOL OptionalControlDescriptionFailure(NSString *role, id value, AXError error) {
    return [@[@"AXCheckBox", @"AXSwitch"] containsObject:role] &&
        [value isKindOfClass:[NSNumber class]] &&
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() && error == kAXErrorFailure;
}

static NSString *ControlDescription(AXUIElementRef element, NSString *role, id value, NSMutableArray *missing) {
    CFTypeRef raw = NULL;
    AXError result = AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute, &raw);
    if (result == kAXErrorNoValue || result == kAXErrorAttributeUnsupported) {
        if (raw) CFRelease(raw);
        return @"";
    }
    if (OptionalControlDescriptionFailure(role, value, result)) {
        if (raw) CFRelease(raw);
        [missing addObject:@{@"attribute":@"AXDescription", @"nativeCode":@(result), @"role":role}];
        return @"";
    }
    if (result != kAXErrorSuccess && raw) CFRelease(raw);
    Require(result == kAXErrorSuccess, @"ACCESSIBILITY_READ_FAILED");
    return ShortText(raw ? CFBridgingRelease(raw) : nil);
}

static void OwnElement(AXUIElementRef element, pid_t expectedPid) {
    pid_t pid = 0;
    Require(element && AXUIElementGetPid(element, &pid) == kAXErrorSuccess && pid == expectedPid,
        @"ACCESSIBILITY_ELEMENT_PID_CHANGED");
}

static id ControlBoolean(id raw) {
    if ([raw isKindOfClass:[NSNumber class]] && ([raw doubleValue] == 0.0 || [raw doubleValue] == 1.0))
        return JSONBoolean([raw boolValue]);
    if ([raw isKindOfClass:[NSString class]] && ([raw isEqual:@"0"] || [raw isEqual:@"1"]))
        return JSONBoolean([raw isEqual:@"1"]);
    return [NSNull null];
}

static NSDictionary *ElementInfo(AXUIElementRef element) {
    NSString *role = ShortText(Attribute(element, kAXRoleAttribute));
    id raw = Attribute(element, kAXValueAttribute);
    id value = ControlBoolean(raw);
    NSString *title = ShortText(Attribute(element, kAXTitleAttribute));
    id titleElement = Attribute(element, kAXTitleUIElementAttribute);
    NSString *label = @"";
    if (titleElement && CFGetTypeID((__bridge CFTypeRef)titleElement) == AXUIElementGetTypeID()) {
        label = ShortText(Attribute((__bridge AXUIElementRef)titleElement, kAXValueAttribute));
        if (!label.length) label = ShortText(Attribute((__bridge AXUIElementRef)titleElement, kAXTitleAttribute));
    }
    NSMutableArray *missing = [NSMutableArray array];
    NSString *description = ControlDescription(element, role, value, missing);
    // A missing optional decoration is never a substitute for an accessible
    // name: the caller still proves one named switch and all pane markers.
    Require(!missing.count || title.length || label.length, @"CONTROL_NAME_REQUIRED");
    id enabled = [@[@"AXButton", @"AXCheckBox", @"AXSwitch"] containsObject:role]
        ? Attribute(element, kAXEnabledAttribute) : nil;
    return @{
        @"role":role,
        @"title":title,
        @"description":description,
        @"identifier":ShortText(Attribute(element, kAXIdentifierAttribute)),
        @"associatedLabel":label,
        @"text":ShortText(raw),
        @"value":value,
        @"enabled":enabled ?: (id)[NSNull null],
        @"optionalReadFailures":missing,
    };
}

static BOOL VoiceOverLabel(NSString *text) {
    NSArray *labels = @[@"VoiceOver", @"旁白", @"启用旁白", @"使用旁白", @"启用 VoiceOver", @"使用 VoiceOver", @"Enable VoiceOver", @"Use VoiceOver", @"Turn on VoiceOver"];
    return [labels containsObject:[text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]];
}

static void Walk(AXUIElementRef element, pid_t pid, NSUInteger depth, NSUInteger *count, NSMutableArray *matches, NSMutableSet *pane) {
    Require(depth <= 24 && ++(*count) <= 2500, @"ACCESSIBILITY_TREE_LIMIT");
    OwnElement(element, pid);
    NSDictionary *info = ElementInfo(element);
    Require(![info[@"role"] isEqual:@"AXSheet"] && ![ShortText(Attribute(element, kAXSubroleAttribute)) isEqual:@"AXDialog"], @"SETTINGS_SHEET_PRESENT");
    NSArray *texts = @[info[@"title"], info[@"description"], info[@"text"]];
    NSArray *descriptions = @[
        @"VoiceOver provides spoken and brailled descriptions of items on the computer screen and provides control of the computer through the use of the keyboard.",
        @"“旁白”可提供电脑屏幕上的项目的口述和盲文描述，并可让你使用键盘来控制电脑。",
        @"「旁白」能提供電腦螢幕項目的語音和點字描述，並能讓你使用鍵盤來控制電腦。",
    ];
    for (NSString *text in texts) if ([descriptions containsObject:text]) [pane addObject:@"voiceOverDescription"];
    if ([info[@"role"] isEqual:@"AXButton"]) {
        for (NSString *text in texts) {
            if ([@[@"Open VoiceOver Training…", @"打开旁白训练…", @"打開「旁白」訓練⋯"] containsObject:text]) [pane addObject:@"trainingButton"];
            if ([@[@"Open VoiceOver Utility…", @"打开旁白实用工具…", @"打開「旁白」工具程式⋯"] containsObject:text]) [pane addObject:@"utilityButton"];
        }
    }
    BOOL role = [@[@"AXCheckBox", @"AXSwitch"] containsObject:info[@"role"]];
    if (role && info[@"value"] != [NSNull null] &&
        (VoiceOverLabel(info[@"title"]) || VoiceOverLabel(info[@"description"]) || VoiceOverLabel(info[@"associatedLabel"])))
        [matches addObject:@{@"info":info, @"element":(__bridge id)element}];
    id children = Attribute(element, kAXChildrenAttribute);
    if (![children isKindOfClass:[NSArray class]]) return;
    for (id child in children) {
        Require(CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID(), @"ACCESSIBILITY_CHILD_INVALID");
        Walk((__bridge AXUIElementRef)child, pid, depth + 1, count, matches, pane);
    }
}

static NSDictionary *SettingsSwitch(NSDictionary *identity) {
    Expected(identity, @[SettingsPath]);
    Require(AXIsProcessTrusted(), @"ACCESSIBILITY_NOT_AUTHORIZED");
    AXUIElementRef app = AXUIElementCreateApplication([identity[@"pid"] intValue]);
    NSMutableArray *matches = [NSMutableArray array];
    @try {
        AXUIElementSetMessagingTimeout(app, 2.0);
        id windows = Attribute(app, kAXWindowsAttribute);
        Require([windows isKindOfClass:[NSArray class]] && [windows count] > 0, @"SETTINGS_WINDOW_NOT_READY");
        Require([windows count] == 1, @"SETTINGS_WINDOW_NOT_UNIQUE");
        AXUIElementRef window = (__bridge AXUIElementRef)windows[0];
        OwnElement(window, [identity[@"pid"] intValue]);
        Require(![Attribute(window, kAXModalAttribute) boolValue], @"SETTINGS_MODAL_PRESENT");
        NSMutableSet *pane = [NSMutableSet set];
        NSUInteger count = 0;
        Walk(window, [identity[@"pid"] intValue], 0, &count, matches, pane);
        Require(pane.count == 3, @"VOICEOVER_PANE_UNCONFIRMED");
        Require(matches.count == 1, @"VOICEOVER_SWITCH_NOT_UNIQUE");
        Expected(identity, @[SettingsPath]);
        CFArrayRef actions = NULL;
        AXError actionRead = AXUIElementCopyActionNames((__bridge AXUIElementRef)matches[0][@"element"], &actions);
        BOOL pressSupported = actionRead == kAXErrorSuccess && actions &&
            [(__bridge NSArray *)actions containsObject:(__bridge NSString *)kAXPressAction];
        if (actions) CFRelease(actions);
        Require(pressSupported, @"ACCESSIBILITY_PRESS_UNSUPPORTED");
        NSMutableDictionary *result = [matches[0] mutableCopy];
        result[@"pressSupported"] = @YES;
        result[@"paneEvidence"] = [[pane allObjects] sortedArrayUsingSelector:@selector(compare:)];
        result[@"windowTitle"] = ShortText(Attribute(window, kAXTitleAttribute));
        return result;
    } @finally { CFRelease(app); }
}

static NSDictionary *PressReply(AXError reply) {
    // An AX failure can mean that the target exited after applying the action.
    // This result never grants permission to repeat the press.
    return @{@"pressAttempted":@YES, @"pressReplyCode":@(reply),
        @"pressReplyUncertain":JSONBoolean(reply != kAXErrorSuccess), @"requiresStateObservation":@YES};
}

static NSDictionary *PressOnce(AXUIElementRef element, BOOL (^revalidate)(void)) {
    CFArrayRef names = NULL;
    AXError read = AXUIElementCopyActionNames(element, &names);
    BOOL present = read == kAXErrorSuccess && names &&
        [(__bridge NSArray *)names containsObject:(__bridge NSString *)kAXPressAction];
    if (names) CFRelease(names);
    Require(read == kAXErrorSuccess, @"ACCESSIBILITY_ACTIONS_UNAVAILABLE");
    Require(present, @"ACCESSIBILITY_PRESS_UNSUPPORTED");
    if (!revalidate())
        return @{@"pressAttempted":@NO, @"alreadyOff":@YES, @"requiresStateObservation":@YES};
    ActionPressStarted = YES;
    return PressReply(AXUIElementPerformAction(element, kAXPressAction));
}

static NSString *WelcomeMarker(NSDictionary *info) {
    if (![info[@"role"] isEqual:@"AXStaticText"]) return nil;
    if ([info[@"text"] isEqual:@"欢迎使用“旁白”"]) return @"welcome";
    if ([info[@"text"] isEqual:@"“旁白”会朗读屏幕上的项目描述，并可让你仅使用键盘来控制电脑。"])
        return @"description";
    return nil;
}

static BOOL WelcomeEvidence(NSString *title, id modal, NSDictionary *markers, NSArray *buttons) {
    return [title isEqual:@"旁白"] && [modal isEqual:@NO] &&
        [markers[@"welcome"] isEqual:@1] && [markers[@"description"] isEqual:@1] &&
        buttons.count == 1 && [buttons[0][@"role"] isEqual:@"AXButton"] &&
        [buttons[0][@"title"] isEqual:@"使用旁白"] && [buttons[0][@"enabled"] isEqual:@YES];
}

static void WalkWelcome(AXUIElementRef element, pid_t pid, NSUInteger depth, NSUInteger *count,
    NSMutableArray *matches, NSMutableDictionary *markers) {
    Require(depth <= 16 && ++(*count) <= 256, @"WELCOME_TREE_LIMIT");
    OwnElement(element, pid);
    NSDictionary *info = ElementInfo(element);
    Require(![info[@"role"] isEqual:@"AXSheet"] &&
        ![ShortText(Attribute(element, kAXSubroleAttribute)) isEqual:@"AXDialog"], @"WELCOME_DIALOG_CHANGED");
    NSString *marker = WelcomeMarker(info);
    if (marker) markers[marker] = @([markers[marker] unsignedIntegerValue] + 1);
    if ([info[@"role"] isEqual:@"AXButton"] && [info[@"title"] isEqual:@"使用旁白"])
        [matches addObject:@{@"info":info, @"element":(__bridge id)element}];
    id children = Attribute(element, kAXChildrenAttribute);
    if (![children isKindOfClass:[NSArray class]]) return;
    for (id child in children) {
        Require(CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID(), @"ACCESSIBILITY_CHILD_INVALID");
        WalkWelcome((__bridge AXUIElementRef)child, pid, depth + 1, count, matches, markers);
    }
}

static NSDictionary *WelcomeButton(NSDictionary *identity) {
    Expected(identity, @[QuickstartPath]);
    Require(AXIsProcessTrusted(), @"ACCESSIBILITY_NOT_AUTHORIZED");
    AXUIElementRef app = AXUIElementCreateApplication([identity[@"pid"] intValue]);
    @try {
        AXUIElementSetMessagingTimeout(app, 2.0);
        id windows = Attribute(app, kAXWindowsAttribute);
        Require([windows isKindOfClass:[NSArray class]] && [windows count] == 1, @"WELCOME_WINDOW_NOT_UNIQUE");
        AXUIElementRef window = (__bridge AXUIElementRef)windows[0];
        OwnElement(window, [identity[@"pid"] intValue]);
        NSString *title = ShortText(Attribute(window, kAXTitleAttribute));
        id modal = Attribute(window, kAXModalAttribute);
        NSMutableArray *matches = [NSMutableArray array], *buttons = [NSMutableArray array];
        NSMutableDictionary *markers = [NSMutableDictionary dictionary];
        NSUInteger count = 0;
        WalkWelcome(window, [identity[@"pid"] intValue], 0, &count, matches, markers);
        for (NSDictionary *match in matches) [buttons addObject:match[@"info"]];
        Require(WelcomeEvidence(title, modal, markers, buttons), @"WELCOME_EVIDENCE_UNCONFIRMED");
        Expected(identity, @[QuickstartPath]);
        return @{@"windowTitle":title, @"method":@"verified-use-button", @"info":buttons[0],
            @"welcomeEvidence":markers, @"element":matches[0][@"element"]};
    } @finally { CFRelease(app); }
}

static NSAppleEventDescriptor *Property(OSType code, NSAppleEventDescriptor *container) {
    NSAppleEventDescriptor *record = [NSAppleEventDescriptor recordDescriptor];
    [record setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:cProperty] forKeyword:keyAEDesiredClass];
    [record setDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:formPropertyID] forKeyword:keyAEKeyForm];
    [record setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:code] forKeyword:keyAEKeyData];
    [record setDescriptor:container ?: [NSAppleEventDescriptor nullDescriptor] forKeyword:keyAEContainer];
    NSAppleEventDescriptor *specifier = [record coerceToDescriptorType:typeObjectSpecifier];
    Require(specifier != nil, @"PROPERTY_DESCRIPTOR_INVALID");
    return specifier;
}

static NSAppleEventDescriptor *Event(pid_t pid, AEEventClass eventClass, AEEventID eventID) {
    return [NSAppleEventDescriptor appleEventWithEventClass:eventClass eventID:eventID
        targetDescriptor:[NSAppleEventDescriptor descriptorWithProcessIdentifier:pid]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
}

static NSAppleEventDescriptor *CommandEvent(pid_t pid, NSString *command) {
    Require([@[@"move voiceover cursor to keyboard focus", @"describe item with keyboard focus"] containsObject:command], @"VOICEOVER_COMMAND_NOT_ALLOWED");
    NSAppleEventDescriptor *event = Event(pid, 'VOAS', 'perC');
    [event setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:command] forKeyword:keyDirectObject];
    [event setAttributeDescriptor:Property('cmmd', nil) forKeyword:'subj'];
    return event;
}

static NSAppleEventDescriptor *MoveEvent(pid_t pid, NSString *direction) {
    Require([@[@"left", @"right"] containsObject:direction], @"VOICEOVER_DIRECTION_NOT_ALLOWED");
    NSAppleEventDescriptor *event = Event(pid, 'core', 'move');
    [event setParamDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:[direction isEqual:@"left"] ? 'lefV' : 'rigV'] forKeyword:keyDirectObject];
    [event setAttributeDescriptor:Property('vocu', nil) forKeyword:'subj'];
    return event;
}

static NSAppleEventDescriptor *PhraseEvent(pid_t pid) {
    NSAppleEventDescriptor *event = Event(pid, 'core', 'getd');
    [event setParamDescriptor:Property('lptx', Property('lapr', nil)) forKeyword:keyDirectObject];
    return event;
}

static BOOL ConsentOptInValid(NSDictionary *request) {
    id allowed = request[@"allowSystemConsentOnce"];
    id intent = request[@"intentId"];
    return allowed && CFGetTypeID((__bridge CFTypeRef)allowed) == CFBooleanGetTypeID() &&
        [allowed boolValue] && [intent isKindOfClass:[NSString class]] &&
        [[NSUUID alloc] initWithUUIDString:intent] != nil &&
        [request[@"firstCommand"] isEqual:FirstVoiceOverCommand];
}

static NSDictionary *ConsentWindows(void) {
    // Window identity metadata only. Do not request screen-recording access or
    // inspect any window title/content. These rows cannot identify a TCC request.
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *windows = [NSMutableArray array];
    BOOL complete = rows != nil && rows.count <= 4096;
    if (complete) for (NSDictionary *row in rows) {
        NSNumber *pid = row[(__bridge NSString *)kCGWindowOwnerPID];
        NSNumber *number = row[(__bridge NSString *)kCGWindowNumber];
        NSNumber *layer = row[(__bridge NSString *)kCGWindowLayer];
        if (![pid isKindOfClass:[NSNumber class]] || ![number isKindOfClass:[NSNumber class]] ||
            ![layer isKindOfClass:[NSNumber class]]) { complete = NO; continue; }
        [windows addObject:@{@"ownerPid":pid, @"windowId":number, @"layer":layer}];
    }
    NSDictionary *foreground = Identity(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
    return @{@"source":@"CGWindowList-on-screen-metadata", @"status":complete ? @"observed" : @"unavailable-or-partial",
        @"foreground":foreground ?: (id)[NSNull null], @"windows":windows,
        @"tccRequestAttribution":@"unknown", @"dialogClosure":@"unknown", @"titlesOrContentsRead":@NO};
}

static NSDictionary *RequestVoiceOverConsent(NSDictionary *request) {
    ConsentAction = YES;
    Require(ConsentOptInValid(request), @"CONSENT_EXPLICIT_OPT_IN_REQUIRED");
    Require([NSThread isMainThread], @"CONSENT_MAIN_RUNLOOP_REQUIRED");
    Require(atomic_load(&ConsentRequestCount) == 0, @"CONSENT_REQUEST_ALREADY_USED");
    NSDictionary *identity = Expected(request[@"identity"], @[VoiceOverPath]);
    NSDictionary *browser = Expected(request[@"browser"], @[ChromePath]);
    RequireUnlockedDesktop();
    Require(NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_NOT_ENABLED");
    Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [browser[@"pid"] intValue],
        @"FOREGROUND_CHANGED");
    struct sigaction interruptAction = {0};
    interruptAction.sa_handler = InterruptConsent;
    sigemptyset(&interruptAction.sa_mask);
    Require(sigaction(SIGINT, &interruptAction, NULL) == 0 &&
        sigaction(SIGTERM, &interruptAction, NULL) == 0, @"CONSENT_INTERRUPT_SETUP_FAILED");
    NSAppleEventDescriptor *first = CommandEvent([identity[@"pid"] intValue], FirstVoiceOverCommand);
    NSAppleEventDescriptor *target = [first attributeDescriptorForKeyword:keyAddressAttr];
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block OSStatus permission = noErr;
    __block NSException *workerFailure = nil;
    NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
    // AppleEvents.h requires a running target and warns that user consent may
    // block indefinitely. The worker never sends an event or resumes checks.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @autoreleasepool {
            @try {
                Expected(identity, @[VoiceOverPath]);
                atomic_fetch_add(&ConsentRequestCount, 1);
                permission = AEDeterminePermissionToAutomateTarget(
                    target.aeDesc, first.eventClass, first.eventID, true);
            } @catch (NSException *exception) { workerFailure = exception; }
            dispatch_semaphore_signal(completed);
        }
    });
    NSTimer *wake = [NSTimer scheduledTimerWithTimeInterval:0.05 repeats:YES block:^(__unused NSTimer *timer) {}];
    @try {
        while (dispatch_semaphore_wait(completed, DISPATCH_TIME_NOW) != 0) {
            Require(!ConsentInterrupted, @"CONSENT_INTERRUPTED");
            Require(NSProcessInfo.processInfo.systemUptime - started < ConsentWaitSeconds, @"CONSENT_USER_WAIT_TIMEOUT");
            Pause(0.05);
        }
        // Cancellation/expiry wins even if the worker returned noErr meanwhile.
        Require(!ConsentInterrupted, @"CONSENT_INTERRUPTED");
        Require(NSProcessInfo.processInfo.systemUptime - started < ConsentWaitSeconds, @"CONSENT_USER_WAIT_TIMEOUT");
        if (workerFailure) @throw workerFailure;
        Expected(identity, @[VoiceOverPath]);
        Expected(browser, @[ChromePath]);
        Require(NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_NOT_ENABLED");
        return @{@"identity":identity, @"browser":browser, @"eventClass":@"VOAS", @"eventID":@"perC",
            @"firstCommand":FirstVoiceOverCommand, @"consentRequestAttempted":@YES, @"askUserIfNeeded":@YES,
            @"permissionStatus":@(permission), @"permissionGranted":JSONBoolean(permission == noErr),
            @"promptDisplayed":@"unknown", @"eventsSent":@0, @"nativeWaitSeconds":@(ConsentWaitSeconds)};
    } @finally { [wake invalidate]; }
    // A timeout/interruption returns through main, ending this helper process.
    // Any unresolved OS decision may persist; no retry or dialog click occurs.
}

static NSWorkspaceOpenConfiguration *SettingsOpenConfiguration(void) {
    NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
    configuration.promptsUserIfNeeded = NO;
    configuration.addsToRecentItems = NO;
    // Prefer the running instance of this exact installation. This is not
    // an atomic no-relaunch guarantee; callback identity is checked below.
    configuration.createsNewApplicationInstance = NO;
    configuration.allowsRunningApplicationSubstitution = NO;
    configuration.activates = YES;
    configuration.hides = NO;
    configuration.hidesOthers = NO;
    configuration.forPrinting = NO;
    return configuration;
}

static NSDictionary *ReopenSettings(NSDictionary *identity) {
    Expected(identity, @[SettingsPath]);
    dispatch_semaphore_t completed = dispatch_semaphore_create(0);
    __block NSRunningApplication *openedApplication = nil;
    __block NSError *openError = nil;
    // NSWorkspace documents completion on a concurrent queue. The semaphore
    // bounds the wait and synchronizes access to the callback values.
    [NSWorkspace.sharedWorkspace openURLs:@[[NSURL URLWithString:SettingsURL]]
        withApplicationAtURL:[NSURL fileURLWithPath:SettingsApplicationPath]
        configuration:SettingsOpenConfiguration()
        completionHandler:^(NSRunningApplication *application, NSError *error) {
            openedApplication = application;
            openError = error;
            dispatch_semaphore_signal(completed);
        }];
    Require(dispatch_semaphore_wait(completed, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC)) == 0,
        @"SETTINGS_REOPEN_CALLBACK_TIMEOUT");
    if (openedApplication)
        Require(openedApplication.processIdentifier == [identity[@"pid"] intValue], @"SETTINGS_REOPEN_PROCESS_CHANGED");
    if (openError || !openedApplication)
        @throw [NSException exceptionWithName:@"ScreenReader" reason:@"SETTINGS_REOPEN_CALLBACK_FAILED"
            userInfo:openError ? @{@"nativeCode":@(openError.code)} : nil];
    Expected(identity, @[SettingsPath]);
    return @{@"method":@"NSWorkspace-openURLs", @"sameProcessConfirmed":@YES,
        @"applicationPath":SettingsApplicationPath, @"url":SettingsURL, @"requiresWindowObservation":@YES};
}

static NSAppleEventDescriptor *Send(NSAppleEventDescriptor *event, NSDictionary *identity) {
    Expected(identity, @[VoiceOverPath]);
    NSAppleEventDescriptor *target = [event attributeDescriptorForKeyword:keyAddressAttr];
    OSStatus permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, event.eventClass, event.eventID, false);
    if (permission != noErr) @throw [NSException exceptionWithName:@"ScreenReader" reason:@"VOICEOVER_AUTOMATION_NOT_AUTHORIZED" userInfo:@{@"nativeCode":@(permission)}];
    NSError *error = nil;
    NSAppleEventDescriptor *reply = [event sendEventWithOptions:SendOptions timeout:5.0 error:&error];
    if (!reply || error) @throw [NSException exceptionWithName:@"ScreenReader" reason:@"VOICEOVER_EVENT_FAILED" userInfo:@{@"nativeCode":@(error.code)}];
    NSAppleEventDescriptor *failure = [reply paramDescriptorForKeyword:keyErrorNumber];
    if (failure && failure.int32Value != 0)
        @throw [NSException exceptionWithName:@"ScreenReader" reason:@"VOICEOVER_REPLY_FAILED" userInfo:@{@"nativeCode":@(failure.int32Value)}];
    Expected(identity, @[VoiceOverPath]);
    return reply;
}

static NSDictionary *DescriptorTests(void) {
    pid_t pid = getpid();
    NSAppleEventDescriptor *command = CommandEvent(pid, @"describe item with keyboard focus");
    NSAppleEventDescriptor *move = MoveEvent(pid, @"right");
    NSAppleEventDescriptor *phrase = PhraseEvent(pid);
    Require(command.eventClass == 'VOAS' && command.eventID == 'perC', @"SELF_TEST_COMMAND");
    Require([[command paramDescriptorForKeyword:keyDirectObject].stringValue isEqual:@"describe item with keyboard focus"], @"SELF_TEST_DIRECT_TEXT");
    Require([command attributeDescriptorForKeyword:keyAddressAttr].descriptorType == typeKernelProcessID, @"SELF_TEST_PID_TARGET");
    Require([command attributeDescriptorForKeyword:keyAddressAttr].data.length == sizeof(pid_t), @"SELF_TEST_PID_LENGTH");
    NSAppleEventDescriptor *subject = [command attributeDescriptorForKeyword:'subj'];
    Require(subject.descriptorType == typeObjectSpecifier && [subject descriptorForKeyword:keyAEKeyData].typeCodeValue == 'cmmd', @"SELF_TEST_SUBJECT");
    Require([subject descriptorForKeyword:keyAEKeyForm].enumCodeValue == formPropertyID && [subject descriptorForKeyword:keyAEDesiredClass].typeCodeValue == cProperty, @"SELF_TEST_PROPERTY_FORM");
    Require([subject descriptorForKeyword:keyAEContainer].descriptorType == typeNull, @"SELF_TEST_NULL_CONTAINER");
    Require(move.eventClass == 'core' && move.eventID == 'move' && [move paramDescriptorForKeyword:keyDirectObject].enumCodeValue == 'rigV', @"SELF_TEST_MOVE");
    Require([[move attributeDescriptorForKeyword:'subj'] descriptorForKeyword:keyAEKeyData].typeCodeValue == 'vocu', @"SELF_TEST_CURSOR_SUBJECT");
    NSAppleEventDescriptor *property = [phrase paramDescriptorForKeyword:keyDirectObject];
    Require(phrase.eventClass == 'core' && phrase.eventID == 'getd' && [property descriptorForKeyword:keyAEKeyData].typeCodeValue == 'lptx', @"SELF_TEST_PHRASE_PROPERTY");
    Require([[property descriptorForKeyword:keyAEContainer] descriptorForKeyword:keyAEKeyData].typeCodeValue == 'lapr', @"SELF_TEST_LAST_PHRASE");
    Require((SendOptions & NSAppleEventSendCanInteract) == 0 && (SendOptions & NSAppleEventSendNeverInteract) != 0, @"SELF_TEST_EVENT_OPTIONS");
    __block NSUInteger fixtureChecks = 0;
    void (^check)(BOOL, NSString *) = ^(BOOL passed, NSString *code) { Require(passed, code); fixtureChecks++; };
    NSDictionary *consentRequest = @{@"allowSystemConsentOnce":@YES,
        @"intentId":@"6c76a9f0-e6b9-4bd9-a53e-41c50dfdcd41", @"firstCommand":FirstVoiceOverCommand};
    check(ConsentOptInValid(consentRequest), @"SELF_TEST_CONSENT_EXPLICIT_OPT_IN");
    for (id value in @[@NO, @1, @"true", [NSNull null]]) {
        NSMutableDictionary *invalid = [consentRequest mutableCopy]; invalid[@"allowSystemConsentOnce"] = value;
        check(!ConsentOptInValid(invalid), @"SELF_TEST_CONSENT_BOOLEAN_REQUIRED");
    }
    NSMutableDictionary *invalidIntent = [consentRequest mutableCopy]; invalidIntent[@"intentId"] = @"not-an-intent";
    check(!ConsentOptInValid(invalidIntent), @"SELF_TEST_CONSENT_INTENT_REQUIRED");
    NSMutableDictionary *otherCommand = [consentRequest mutableCopy]; otherCommand[@"firstCommand"] = @"describe item with keyboard focus";
    check(!ConsentOptInValid(otherCommand), @"SELF_TEST_CONSENT_FIRST_EVENT_ONLY");
    NSAppleEventDescriptor *first = CommandEvent(pid, FirstVoiceOverCommand);
    check(first.eventClass == 'VOAS' && first.eventID == 'perC' &&
        [first attributeDescriptorForKeyword:keyAddressAttr].descriptorType == typeKernelProcessID &&
        [[first paramDescriptorForKeyword:keyDirectObject].stringValue isEqual:FirstVoiceOverCommand],
        @"SELF_TEST_CONSENT_EXACT_FIRST_EVENT");
    check((SendOptions & (NSAppleEventSendOptions)kAEDoNotPromptForUserConsent) != 0,
        @"SELF_TEST_SEND_DO_NOT_PROMPT_FOR_CONSENT");
    check(atomic_load(&ConsentRequestCount) == 0, @"SELF_TEST_ZERO_CONSENT_REQUESTS");
    NSWorkspaceOpenConfiguration *configuration = SettingsOpenConfiguration();
    check(!configuration.promptsUserIfNeeded && !configuration.addsToRecentItems, @"SELF_TEST_SETTINGS_NO_PROMPTS_OR_RECENTS");
    check(!configuration.createsNewApplicationInstance && !configuration.allowsRunningApplicationSubstitution,
        @"SELF_TEST_SETTINGS_REUSE_EXACT_INSTALLATION");
    check(configuration.activates && !configuration.hides && !configuration.hidesOthers &&
        !configuration.isForPrinting && configuration.appleEvent == nil, @"SELF_TEST_SETTINGS_NAVIGATION_ONLY");
    check(OptionalControlDescriptionFailure(@"AXCheckBox", @YES, kAXErrorFailure), @"SELF_TEST_OPTIONAL_DESCRIPTION");
    check(OptionalControlDescriptionFailure(@"AXSwitch", @NO, kAXErrorFailure), @"SELF_TEST_OPTIONAL_OFF_DESCRIPTION");
    check(!OptionalControlDescriptionFailure(@"AXButton", @YES, kAXErrorFailure), @"SELF_TEST_BUTTON_ERROR_NOT_OPTIONAL");
    check(!OptionalControlDescriptionFailure(@"AXCheckBox", [NSNull null], kAXErrorFailure), @"SELF_TEST_UNKNOWN_SWITCH_NOT_OPTIONAL");
    check(!OptionalControlDescriptionFailure(@"AXSwitch", @YES, kAXErrorCannotComplete), @"SELF_TEST_TIMEOUT_NOT_OPTIONAL");
    check(!OptionalControlDescriptionFailure(@"AXSwitch", @YES, kAXErrorInvalidUIElement), @"SELF_TEST_STALE_ELEMENT_NOT_OPTIONAL");
    check([ControlBoolean(@0.25) isEqual:[NSNull null]] && [ControlBoolean(@"true") isEqual:[NSNull null]], @"SELF_TEST_INVALID_SWITCH_VALUES");
    NSDictionary *buttons = @{@"role":@"AXButton", @"title":@"使用旁白", @"enabled":@YES};
    NSDictionary *markers = @{@"welcome":@1, @"description":@1};
    check(WelcomeEvidence(@"旁白", @NO, markers, @[buttons]), @"SELF_TEST_REAL_WELCOME");
    check(!WelcomeEvidence(@"旁白", @NO, @{}, @[buttons]), @"SELF_TEST_TITLE_ALONE_NOT_WELCOME");
    check(!WelcomeEvidence(@"旁白", @NO, markers, @[buttons, buttons]), @"SELF_TEST_DUPLICATE_WELCOME_BUTTON");
    check(!WelcomeEvidence(@"旁白", @YES, markers, @[buttons]), @"SELF_TEST_MODAL_WELCOME_REJECTED");
    check(!WelcomeEvidence(@"旁白", @NO, @{@"welcome":@2, @"description":@1}, @[buttons]), @"SELF_TEST_DUPLICATE_WELCOME_MARKER");
    check(!WelcomeEvidence(@"旁白", @NO, markers, @[@{@"role":@"AXButton", @"title":@"关闭旁白", @"enabled":@YES}]), @"SELF_TEST_OFF_BUTTON_NOT_CONTINUE");
    check(!WelcomeEvidence(@"旁白", @NO, markers, @[@{@"role":@"AXButton", @"title":@"使用旁白", @"enabled":@NO}]), @"SELF_TEST_DISABLED_CONTINUE");
    NSDictionary *uncertain = PressReply(kAXErrorFailure);
    check([uncertain[@"pressAttempted"] isEqual:@YES] && [uncertain[@"pressReplyUncertain"] isEqual:@YES] &&
        [uncertain[@"requiresStateObservation"] isEqual:@YES], @"SELF_TEST_FAILED_REPLY_MAY_HAVE_APPLIED");
    NSDictionary *row = @{@"kCGSSessionOnConsoleKey":@YES, @"kCGSSessionUserIDKey":@501};
    NSDictionary *foreground = @{@"pid":@1234, @"uid":@501, @"path":ChromePath};
    check([DesktopFromRows(@[row], foreground, 501)[@"unlocked"] isEqual:@YES], @"SELF_TEST_HOST_UNLOCKED_SAMPLE");
    NSMutableDictionary *locked = [row mutableCopy]; locked[@"CGSSessionScreenIsLocked"] = @YES;
    check([DesktopFromRows(@[locked], foreground, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_LOCKED_REJECTED");
    locked[@"CGSSessionScreenIsLocked"] = @"false";
    check([DesktopFromRows(@[locked], foreground, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_MALFORMED_LOCK_REJECTED");
    check([DesktopFromRows(@[], foreground, 501)[@"unlocked"] isEqual:@NO] &&
        [DesktopFromRows(@[row, row], foreground, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_CONSOLE_AMBIGUOUS");
    check([DesktopFromRows(@[row], foreground, 502)[@"unlocked"] isEqual:@NO], @"SELF_TEST_OTHER_UID_REJECTED");
    check([DesktopFromRows(@[row], @{@"pid":@176, @"uid":@501, @"path":LoginwindowPath}, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_LOGINWINDOW_REJECTED");
    check([DesktopFromRows(@[row], nil, 501)[@"unlocked"] isEqual:@NO] &&
        [DesktopFromRows(nil, foreground, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_UNKNOWN_DESKTOP_REJECTED");
    check([DesktopFromRows(@[@{@"kCGSSessionOnConsoleKey":@1, @"kCGSSessionUserIDKey":@501}], foreground, 501)[@"unlocked"] isEqual:@NO], @"SELF_TEST_CONSOLE_BOOLEAN_REQUIRED");
    NSDictionary *protocol = @{
        @"desktop":DesktopFromRows(@[row], foreground, 501),
        @"press":PressReply(kAXErrorFailure),
        @"conditionalObservation":JSONBoolean(YES || NO),
        @"permissionSample":JSONBoolean((unsigned char)1),
    };
    NSData *wire = [NSJSONSerialization dataWithJSONObject:protocol options:0 error:NULL];
    NSDictionary *decoded = wire ? [NSJSONSerialization JSONObjectWithData:wire options:0 error:NULL] : nil;
    check(decoded != nil, @"SELF_TEST_JSON_ROUNDTRIP");
    for (NSString *key in @[@"consoleRowsValid", @"consoleUserMatches", @"screenLockKeyExists",
        @"screenLockKnown", @"screenLocked", @"foregroundIsLoginwindow", @"unlocked"]) {
        id value = decoded[@"desktop"][key];
        check(value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(), @"SELF_TEST_JSON_DESKTOP_BOOLEAN");
    }
    for (NSString *key in @[@"pressAttempted", @"pressReplyUncertain", @"requiresStateObservation"]) {
        id value = decoded[@"press"][key];
        check(value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(), @"SELF_TEST_JSON_PRESS_BOOLEAN");
    }
    check(CFGetTypeID((__bridge CFTypeRef)decoded[@"conditionalObservation"]) == CFBooleanGetTypeID() &&
        CFGetTypeID((__bridge CFTypeRef)decoded[@"permissionSample"]) == CFBooleanGetTypeID(), @"SELF_TEST_JSON_C_EXPRESSION_BOOLEAN");
    return @{@"status":@"passed", @"checks":@(12 + fixtureChecks), @"descriptorChecks":@12,
        @"contractFixtureChecks":@(fixtureChecks), @"eventsSent":@0, @"consentRequests":@(atomic_load(&ConsentRequestCount)),
        @"osStateObserved":@NO, @"osStateChanged":@NO};
}

static NSDictionary *Perform(NSString *action, NSDictionary *request) {
    if ([action isEqual:@"self-test"]) return DescriptorTests();
    if ([action isEqual:@"observe"]) return Snapshot();
    if ([action isEqual:@"consent-windows"]) return ConsentWindows();
    if ([action isEqual:@"voiceover-consent"]) return RequestVoiceOverConsent(request);
    if ([action isEqual:@"identity"]) return @{@"identity":Identity([request[@"pid"] intValue]) ?: (id)[NSNull null]};
    if ([action isEqual:@"scripting-preference"]) {
        NSDictionary *desired = request[@"desired"];
        Require([desired isKindOfClass:[NSDictionary class]] && [desired[@"exists"] isKindOfClass:[NSNumber class]], @"PREFERENCE_REQUEST_INVALID");
        if ([desired[@"exists"] boolValue]) TypedBoolean(desired[@"value"]);
        CFPreferencesSetAppValue(CFSTR("SCREnableAppleScript"), [desired[@"exists"] boolValue] ? ([desired[@"value"] boolValue] ? kCFBooleanTrue : kCFBooleanFalse) : NULL, CFSTR("com.apple.VoiceOver4"));
        Require(CFPreferencesAppSynchronize(CFSTR("com.apple.VoiceOver4")), @"PREFERENCE_SYNC_FAILED");
        return @{@"changed":@YES};
    }
    if ([action isEqual:@"settings-open"]) {
        for (NSDictionary *row in KnownProcesses()) Require(![row[@"kind"] isEqual:@"settings"], @"SETTINGS_ALREADY_RUNNING");
        Require([[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:SettingsURL]], @"SETTINGS_OPEN_FAILED");
        return @{@"opened":@YES, @"url":SettingsURL};
    }
    if ([action isEqual:@"settings-reopen"]) return ReopenSettings(request[@"identity"]);
    if ([action isEqual:@"settings-read"] || [action isEqual:@"settings-on"] || [action isEqual:@"settings-off"]) {
        BOOL on = [action isEqual:@"settings-on"], off = [action isEqual:@"settings-off"];
        Expected(request[@"identity"], @[SettingsPath]);
        // An already-off getter must never turn an old on-looking checkbox
        // into a reverse toggle. The driver still waits for both preference
        // views to agree, and records the actual final native state.
        if (off && !NSWorkspace.sharedWorkspace.isVoiceOverEnabled)
            return @{@"pressAttempted":@NO, @"alreadyOff":@YES, @"requiresStateObservation":@YES};
        if (on) {
            RequireUnlockedDesktop();
            Expected(request[@"browser"], @[ChromePath]);
            Require(!NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_ALREADY_ENABLED");
            for (NSDictionary *row in KnownProcesses())
                Require([row[@"kind"] isEqual:@"settings"] && [row[@"identity"] isEqual:request[@"identity"]], @"VOICEOVER_PROCESS_ALREADY_PRESENT");
        }
        NSDictionary *found = SettingsSwitch(request[@"identity"]);
        NSDictionary *before = found[@"info"];
        NSMutableDictionary *result = [@{@"switch":before, @"paneEvidence":found[@"paneEvidence"],
            @"windowTitle":found[@"windowTitle"], @"pressSupported":found[@"pressSupported"],
            @"pressAttempted":@NO, @"requiresStateObservation":JSONBoolean(on || off)} mutableCopy];
        if (!on && !off) result[@"voiceOverEnabled"] = JSONBoolean(NSWorkspace.sharedWorkspace.isVoiceOverEnabled);
        if (on || off) {
            Require([before[@"value"] isEqual:JSONBoolean(!on)] && [before[@"enabled"] isEqual:@YES], @"SETTINGS_SWITCH_STATE_CHANGED");
            NSDictionary *fresh = SettingsSwitch(request[@"identity"]);
            Require([fresh[@"info"] isEqual:before] &&
                CFEqual((__bridge CFTypeRef)fresh[@"element"], (__bridge CFTypeRef)found[@"element"]), @"SETTINGS_SWITCH_CHANGED");
            Expected(request[@"identity"], @[SettingsPath]);
            if (on) {
                RequireUnlockedDesktop();
                Expected(request[@"browser"], @[ChromePath]);
                Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [request[@"browser"][@"pid"] intValue], @"FOREGROUND_CHANGED");
                Require(!NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_ALREADY_ENABLED");
            } else if (!NSWorkspace.sharedWorkspace.isVoiceOverEnabled) {
                result[@"alreadyOff"] = @YES;
                return result;
            }
            OwnElement((__bridge AXUIElementRef)fresh[@"element"], [request[@"identity"][@"pid"] intValue]);
            Require([ControlBoolean(Attribute((__bridge AXUIElementRef)fresh[@"element"], kAXValueAttribute)) isEqual:JSONBoolean(!on)],
                @"SETTINGS_SWITCH_STATE_CHANGED");
            [result addEntriesFromDictionary:PressOnce((__bridge AXUIElementRef)fresh[@"element"], ^BOOL {
                Expected(request[@"identity"], @[SettingsPath]);
                OwnElement((__bridge AXUIElementRef)fresh[@"element"], [request[@"identity"][@"pid"] intValue]);
                if (on) {
                    RequireUnlockedDesktop();
                    Expected(request[@"browser"], @[ChromePath]);
                    Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [request[@"browser"][@"pid"] intValue], @"FOREGROUND_CHANGED");
                    Require(!NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_ALREADY_ENABLED");
                } else if (!NSWorkspace.sharedWorkspace.isVoiceOverEnabled) return NO;
                Require([ControlBoolean(Attribute((__bridge AXUIElementRef)fresh[@"element"], kAXValueAttribute)) isEqual:JSONBoolean(!on)] &&
                    [Attribute((__bridge AXUIElementRef)fresh[@"element"], kAXEnabledAttribute) isEqual:@YES], @"SETTINGS_SWITCH_STATE_CHANGED");
                if (on) {
                    RequireUnlockedDesktop();
                    Require(!NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_ALREADY_ENABLED");
                } else if (!NSWorkspace.sharedWorkspace.isVoiceOverEnabled) return NO;
                return YES;
            })];
        }
        return result;
    }
    if ([action isEqual:@"welcome-read"] || [action isEqual:@"welcome-continue"]) {
        NSDictionary *found = WelcomeButton(request[@"identity"]);
        NSMutableDictionary *result = [@{@"windowTitle":found[@"windowTitle"], @"button":found[@"info"],
            @"method":found[@"method"], @"welcomeEvidence":found[@"welcomeEvidence"], @"pressAttempted":@NO} mutableCopy];
        if ([action isEqual:@"welcome-continue"]) {
            Require([found[@"windowTitle"] isEqual:request[@"windowTitle"]] && [found[@"info"] isEqual:request[@"button"]] &&
                [found[@"method"] isEqual:request[@"method"]] && [found[@"welcomeEvidence"] isEqual:request[@"welcomeEvidence"]], @"WELCOME_ACTION_CHANGED");
            RequireUnlockedDesktop();
            Require(NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_NOT_ENABLED");
            Expected(request[@"identity"], @[QuickstartPath]);
            [result addEntriesFromDictionary:PressOnce((__bridge AXUIElementRef)found[@"element"], ^BOOL {
                RequireUnlockedDesktop();
                Require(NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_NOT_ENABLED");
                Expected(request[@"identity"], @[QuickstartPath]);
                OwnElement((__bridge AXUIElementRef)found[@"element"], [request[@"identity"][@"pid"] intValue]);
                Require([ShortText(Attribute((__bridge AXUIElementRef)found[@"element"], kAXTitleAttribute)) isEqual:@"使用旁白"] &&
                    [Attribute((__bridge AXUIElementRef)found[@"element"], kAXEnabledAttribute) isEqual:@YES], @"WELCOME_ACTION_CHANGED");
                RequireUnlockedDesktop();
                return YES;
            })];
        }
        return result;
    }
    if ([action isEqual:@"foreground"]) {
        NSDictionary *identity = Expected(request[@"identity"], nil);
        NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:[identity[@"pid"] intValue]];
        Require(app && [app activateWithOptions:NSApplicationActivateIgnoringOtherApps], @"FOREGROUND_ACTIVATION_FAILED");
        Pause(0.2);
        Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [identity[@"pid"] intValue], @"FOREGROUND_CHANGED");
        return @{@"identity":Expected(identity, nil)};
    }
    if ([action isEqual:@"voiceover"]) {
        NSDictionary *identity = Expected(request[@"identity"], @[VoiceOverPath]);
        NSDictionary *browser = Expected(request[@"browser"], @[ChromePath]);
        Require(NSWorkspace.sharedWorkspace.isVoiceOverEnabled, @"VOICEOVER_NOT_ENABLED");
        Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [browser[@"pid"] intValue], @"FOREGROUND_CHANGED");
        NSString *kind = request[@"kind"];
        pid_t pid = [identity[@"pid"] intValue];
        if ([kind isEqual:@"command"]) Send(CommandEvent(pid, request[@"command"]), identity);
        else if ([kind isEqual:@"move"]) Send(MoveEvent(pid, request[@"direction"]), identity);
        else Require([kind isEqual:@"last"], @"VOICEOVER_ACTION_INVALID");
        Pause(0.35);
        NSAppleEventDescriptor *reply = Send(PhraseEvent(pid), identity);
        NSString *phrase = [reply paramDescriptorForKeyword:keyDirectObject].stringValue;
        Require(phrase.length > 0 && phrase.length <= 8192, @"VOICEOVER_PHRASE_EMPTY_OR_LARGE");
        Expected(browser, @[ChromePath]);
        Require(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == [browser[@"pid"] intValue], @"FOREGROUND_CHANGED");
        return @{@"phrase":phrase, @"identity":identity, @"pidAddressed":@YES, @"capturedAt":Now()};
    }
    if ([action isEqual:@"terminate"]) {
        NSDictionary *identity = Expected(request[@"identity"], @[VoiceOverPath, StarterPath, QuickstartPath, SettingsPath, ChromePath]);
        Require([request[@"signal"] isEqual:@"TERM"] || [request[@"signal"] isEqual:@"KILL"], @"SIGNAL_INVALID");
        Require(kill([identity[@"pid"] intValue], [request[@"signal"] isEqual:@"TERM"] ? SIGTERM : SIGKILL) == 0 || errno == ESRCH, @"PROCESS_TERMINATION_FAILED");
        return @{@"signalled":@YES};
    }
    Require(NO, @"ACTION_NOT_ALLOWED");
    return nil;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        int code = 0;
        NSDictionary *output;
        @try {
            Require(argc == 5 && strcmp(argv[1], "--action") == 0 && strcmp(argv[3], "--session") == 0, @"USAGE_INVALID");
            NSString *action = [NSString stringWithUTF8String:argv[2]];
            NSString *session = [NSString stringWithUTF8String:argv[4]];
            Require([[NSUUID alloc] initWithUUIDString:session] != nil, @"SESSION_INVALID");
            NSData *data = [[NSFileHandle fileHandleWithStandardInput] readDataOfLength:65537];
            Require(data.length <= 65536, @"REQUEST_LIMIT");
            NSError *error = nil;
            id request = data.length ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : @{};
            Require([request isKindOfClass:[NSDictionary class]] && !error, @"REQUEST_INVALID");
            output = @{@"ok":@YES, @"result":Perform(action, request)};
        } @catch (NSException *exception) {
            code = 1;
            NSString *reason = [exception.name isEqual:@"ScreenReader"] ? exception.reason : @"NATIVE_UNEXPECTED_FAILURE";
            NSMutableDictionary *failure = [@{@"ok":@NO, @"code":[@"SCREEN_READER_" stringByAppendingString:reason],
                @"pressAttempted":JSONBoolean(ActionPressStarted), @"nativeCode":exception.userInfo[@"nativeCode"] ?: (id)[NSNull null]} mutableCopy];
            if (ConsentAction) {
                failure[@"consentRequestAttempted"] = JSONBoolean(atomic_load(&ConsentRequestCount) != 0);
                failure[@"permissionOutcome"] = @"unknown";
                failure[@"promptDisplayed"] = @"unknown";
            }
            output = failure;
        }
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:output options:NSJSONWritingSortedKeys error:NULL];
        [[NSFileHandle fileHandleWithStandardOutput] writeData:encoded];
        [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
        return code;
    }
}
