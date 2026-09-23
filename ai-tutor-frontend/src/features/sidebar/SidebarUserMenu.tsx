import React from "react";
import type { RefObject } from "react";

interface SidebarUserMenuProps {
  isUserMenuOpen: boolean;
  setIsUserMenuOpen: (open: boolean) => void;
  userMenuRef: RefObject<HTMLDivElement>;
  userEmail: string;
  userInitial: string;
  showDetails?: boolean;
  onOpenPrivacyPolicy: () => void;
  onOpenTermsOfService: () => void;
  onLogout: () => void;
}

export const SidebarUserMenu: React.FC<SidebarUserMenuProps> = ({
  isUserMenuOpen,
  setIsUserMenuOpen,
  userMenuRef,
  userEmail,
  userInitial,
  showDetails = true,
  onOpenPrivacyPolicy,
  onOpenTermsOfService,
  onLogout,
}) => (
  <div
    className={`relative w-full ${showDetails ? "" : "flex justify-center"}`}
    ref={userMenuRef}
  >
    <button
      className={`flex items-center rounded-lg hover:bg-gray-800 transition-colors ${
        showDetails
          ? "w-full gap-3 px-2 py-2"
          : "w-10 h-10 justify-center p-0 mx-auto"
      }`}
      onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
      aria-label="User menu"
    >
      <span className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-white font-bold shrink-0">
        {userInitial}
      </span>
      {showDetails && (
        <span className="min-w-0 text-left">
          <span className="block text-xs uppercase tracking-wide text-gray-400">
            Signed in
          </span>
          <span className="block text-sm font-medium text-gray-100 truncate">
            {userEmail}
          </span>
        </span>
      )}
    </button>
    {isUserMenuOpen && (
      <div className="absolute right-0 bottom-full mb-2 w-56 bg-white rounded-md shadow-lg py-2 z-50">
        <div className="px-4 py-2 text-gray-700 text-sm">{userEmail}</div>
        <button
          type="button"
          onClick={() => {
            setIsUserMenuOpen(false);
            onOpenPrivacyPolicy();
          }}
          className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Privacy Policy
        </button>
        <button
          type="button"
          onClick={() => {
            setIsUserMenuOpen(false);
            onOpenTermsOfService();
          }}
          className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Terms of Service
        </button>
        <button
          type="button"
          onClick={() => {
            setIsUserMenuOpen(false);
            onLogout();
          }}
          className="w-full text-left px-4 py-2 text-sm text-rose-600 hover:bg-gray-50"
        >
          Log out
        </button>
      </div>
    )}
  </div>
);
