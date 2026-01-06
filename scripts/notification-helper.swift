#!/usr/bin/env swift
// notification-helper.swift
// A helper to check macOS notification authorization status
// This needs to be run from within an app bundle context
//
// When compiled as a standalone binary, it uses the parent Electron app's
// bundle identifier by setting CFBundleIdentifier environment variable

import Cocoa
import UserNotifications

// Create a minimal NSApplication context
// This allows UNUserNotificationCenter to work
let app = NSApplication.shared

// Create a semaphore to wait for the async call
let semaphore = DispatchSemaphore(value: 0)
var result = "unknown"

// Register for notification to handle async completion
DispatchQueue.main.async {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized:
            result = "authorized"
        case .denied:
            result = "denied"
        case .notDetermined:
            result = "not-determined"
        case .provisional:
            result = "provisional"
        case .ephemeral:
            result = "ephemeral"
        @unknown default:
            result = "unknown"
        }
        semaphore.signal()
    }
}

// Run the run loop briefly to allow the async call to complete
let runLoop = RunLoop.current
let timeout = Date(timeIntervalSinceNow: 5.0)
while semaphore.wait(timeout: .now()) == .timedOut && runLoop.run(mode: .default, before: timeout) {
    // Keep running until we get a response or timeout
}

// Final check in case run loop exited
if result == "unknown" {
    _ = semaphore.wait(timeout: .now() + .seconds(1))
}

print(result)
exit(0)
